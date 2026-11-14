<?php
declare(strict_types=1);

// Alles wat per ongeluk wordt uitgevoerd vóór het antwoord (een BOM of tekst aan het begin van
// config.php) wordt opgevangen en weggegooid, zodat het JSON-antwoord altijd schoon blijft.
ob_start();

require __DIR__ . '/lib.php';

// Kleine API: index.php?action=me|login|logout|data|sync
try {
    switch ($_GET['action'] ?? '') {
        case 'me':
            requireMethod('GET');
            $s = requireSession();
            respond(200, [
                'user'      => ['id' => $s['user_id'], 'name' => $s['name']],
                'expiresAt' => $s['expires_at'],
            ]);

        case 'health':
            requireMethod('GET');
            health();

        case 'login':
            requireMethod('POST');
            login(readJson());

        case 'logout':
            requireMethod('POST');
            readJson();
            endSession();
            respond(200, ['ok' => true]);

        case 'data':
            requireMethod('GET');
            sendData(requireSession()['user_id']);

        case 'sync':
            requireMethod('POST');
            $session = requireSession();
            sync($session['user_id'], readJson());

        default:
            fail(404, 'Onbekende actie.');
    }
} catch (Throwable $e) {
    error_log('rancune api: ' . $e);
    fail(500, 'Er ging iets mis op de server.');
}

/** Controleert configuratie, databaseverbinding en tabellen. Geeft alleen de mislukte stap terug. */
function health(): never
{
    $stage = 'databaseverbinding (api/config.php)';
    try {
        $pdo = db();
        $stage = 'tabel users van het toernooi';
        $pdo->query('SELECT 1 FROM users LIMIT 1');
        foreach (['rancune_sessions', 'rancune_players', 'rancune_games', 'rancune_attempts'] as $table) {
            $stage = "tabel $table (api/schema.sql)";
            $pdo->query("SELECT 1 FROM $table LIMIT 1");
        }
    } catch (Throwable $e) {
        error_log("rancune health ($stage): " . $e->getMessage());
        // Alleen het type fout (bijv. 1045 = verkeerd wachtwoord), nooit gegevens of de volledige melding.
        $kind = get_class($e) . ($e instanceof PDOException ? ' ' . $e->getCode() : '');
        fail(503, "Controle mislukt bij: $stage [$kind]");
    }
    respond(200, ['ok' => true]);
}

/**
 * Inloggen met de accounts van de Exploding Kraken-site, met dezelfde regels als daar:
 * spelers loggen in met hun e-mailadres, de beheerder mag ook met zijn gebruikersnaam.
 */
function login(array $in): never
{
    $identifier = trim((string) ($in['identifier'] ?? ''));
    $password = (string) ($in['password'] ?? '');
    if ($identifier === '' || $password === '' || mb_strlen($identifier) > 180 || strlen($password) > 200) {
        fail(400, 'Vul je e-mailadres en wachtwoord in.');
    }

    $ip = clientIp();
    $who = mb_strtolower($identifier);
    if (tooManyAttempts('login_user', $who, 5) || tooManyAttempts('login_ip', $ip, 10)) {
        fail(429, 'Te veel mislukte loginpogingen. Wacht 15 minuten en probeer opnieuw.');
    }

    if (str_contains($identifier, '@')) {
        $st = db()->prepare('SELECT id, password_hash FROM users WHERE email = ?');
    } else {
        $st = db()->prepare("SELECT id, password_hash FROM users WHERE username = ? AND role = 'admin'");
    }
    $st->execute([$identifier]);
    $user = $st->fetch();

    // Altijd password_verify aanroepen, ook bij een onbekend adres.
    $valid = password_verify($password, $user['password_hash'] ?? DUMMY_HASH) && $user;
    if (!$valid) {
        recordAttempt('login_user', $who);
        recordAttempt('login_ip', $ip);
        fail(401, 'Ongeldige login.');
    }

    clearAttempts('login_user', $who);
    clearAttempts('login_ip', $ip);
    $expires = startSession((int) $user['id']);
    $s = db()->prepare('SELECT name FROM users WHERE id = ?');
    $s->execute([$user['id']]);
    respond(200, [
        'user'      => ['id' => (int) $user['id'], 'name' => (string) $s->fetchColumn()],
        'expiresAt' => $expires,
    ]);
}

function sendData(int $userId): never
{
    $st = db()->prepare('SELECT id, name FROM rancune_players WHERE user_id = ? ORDER BY n');
    $st->execute([$userId]);
    $players = $st->fetchAll();

    $st = db()->prepare('SELECT data FROM rancune_games WHERE user_id = ? ORDER BY start_at, id');
    $st->execute([$userId]);
    $games = array_map(fn ($row) => json_decode($row['data'], true), $st->fetchAll());

    respond(200, ['players' => $players, 'games' => $games]);
}

/** Verwerkt een batch wijzigingen van de app: nieuwe/gewijzigde spelers en potjes, en verwijderingen. */
function sync(int $userId, array $in): never
{
    $players = $in['players'] ?? [];
    $games = $in['games'] ?? [];
    if (!is_array($players) || !is_array($games) || count($players) > 200 || count($games) > 200) {
        fail(400, 'Te veel wijzigingen in één keer.');
    }
    $players = array_map('cleanPlayer', array_values($players));
    $games = array_map('cleanGame', array_values($games));
    $deletePlayers = idList($in['deletePlayers'] ?? null, 500);
    $deleteGames = idList($in['deleteGames'] ?? null, 500);

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $upPlayer = $pdo->prepare(
            'INSERT INTO rancune_players (user_id, id, name) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name)'
        );
        foreach ($players as $p) {
            $upPlayer->execute([$userId, $p['id'], $p['name']]);
        }

        $upGame = $pdo->prepare(
            'INSERT INTO rancune_games (user_id, id, start_at, data, updated_at) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE start_at = VALUES(start_at), data = VALUES(data), updated_at = VALUES(updated_at)'
        );
        foreach ($games as $g) {
            $upGame->execute([
                $userId, $g['id'], $g['start'],
                json_encode($g, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), time(),
            ]);
        }

        $delPlayer = $pdo->prepare('DELETE FROM rancune_players WHERE user_id = ? AND id = ?');
        foreach ($deletePlayers as $id) {
            $delPlayer->execute([$userId, $id]);
        }
        $delGame = $pdo->prepare('DELETE FROM rancune_games WHERE user_id = ? AND id = ?');
        foreach ($deleteGames as $id) {
            $delGame->execute([$userId, $id]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    respond(200, ['ok' => true]);
}
