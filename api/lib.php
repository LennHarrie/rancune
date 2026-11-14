<?php
declare(strict_types=1);

const SESSION_COOKIE = 'rancune_session';
const MAX_BODY       = 2 * 1024 * 1024;
const TYPES          = ['normal', 'commander', 'toxic'];
const OUTCOMES       = ['won', 'lost', 'stopped'];
// Geldige bcrypt-hash van een willekeurig wachtwoord. Zo duurt inloggen met een onbekend adres
// even lang als met een bekend adres, en is via de responstijd niet te zien welke adressen bestaan.
const DUMMY_HASH     = '$2y$10$jpdxD30znbBUOnJ6A2t4e.7JYOiOpqlc/ZXVgxkKbEFHdR9eoknra';

/* ---------- Basis ---------- */

function respond(int $status, array $body): never
{
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(int $status, string $message): never
{
    respond($status, ['error' => $message]);
}

function cfg(): array
{
    static $config = null;
    if ($config === null) {
        $file = __DIR__ . '/config.php';
        if (!is_file($file)) {
            fail(500, 'Server niet geconfigureerd (api/config.php ontbreekt).');
        }
        $config = require $file;
        if (!is_array($config)) {
            fail(500, 'api/config.php is geen geldig configuratiebestand: het moet beginnen met <?php en een lijst teruggeven (return [ ... ];).');
        }
        // Optioneel: databasegegevens overnemen uit het config.php van Exploding Kraken.
        $ek = (string) ($config['ek_config'] ?? '');
        if ($ek !== '') {
            if (!is_file($ek)) {
                fail(500, 'ek_config in api/config.php wijst naar een bestand dat niet bestaat.');
            }
            $ekConfig = require $ek;
            if (!is_array($ekConfig)) {
                fail(500, 'Het config.php van het toernooi (ek_config) geeft geen lijst met instellingen terug.');
            }
            foreach (['db_host', 'db_name', 'db_user', 'db_pass'] as $key) {
                $config[$key] = $ekConfig[$key] ?? null;
            }
        }
    }
    return $config;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $c = cfg();
        foreach (['db_host', 'db_name', 'db_user'] as $key) {
            if (!isset($c[$key]) || $c[$key] === '') {
                fail(500, "Databaseinstelling '$key' ontbreekt. Staat die in het config.php van het toernooi (ek_config), of vul je hem zelf in api/config.php?");
            }
        }
        $c['db_pass'] = (string) ($c['db_pass'] ?? '');
        $pdo = new PDO(
            "mysql:host={$c['db_host']};dbname={$c['db_name']};charset=utf8mb4",
            $c['db_user'],
            $c['db_pass'],
            [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]
        );
    }
    return $pdo;
}

function sessionTtl(): int
{
    return max(1, (int) (cfg()['session_hours'] ?? 24)) * 3600;
}

function isHttps(): bool
{
    $https = $_SERVER['HTTPS'] ?? '';
    return ($https !== '' && $https !== 'off')
        || strtolower($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

function clientIp(): string
{
    return substr($_SERVER['REMOTE_ADDR'] ?? 'unknown', 0, 45);
}

/* ---------- Invoer ---------- */

function requireMethod(string $method): void
{
    if ($_SERVER['REQUEST_METHOD'] !== $method) {
        header('Allow: ' . $method);
        fail(405, 'Methode niet toegestaan.');
    }
}

/**
 * Leest een JSON-body. Alleen application/json wordt geaccepteerd en een Origin van een
 * ander domein wordt geweigerd; samen met de SameSite=Strict-cookie houdt dat CSRF buiten de deur.
 */
function readJson(): array
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '') {
        $host = (string) parse_url($origin, PHP_URL_HOST);
        $port = parse_url($origin, PHP_URL_PORT);
        $originHost = strtolower($host . ($port ? ':' . $port : ''));
        if ($originHost !== strtolower($_SERVER['HTTP_HOST'] ?? '')) {
            fail(403, 'Ongeldige herkomst.');
        }
    }
    if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== 0) {
        fail(415, 'JSON verwacht.');
    }
    $raw = (string) file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
    if (strlen($raw) > MAX_BODY) {
        fail(413, 'Verzoek is te groot.');
    }
    $data = json_decode($raw, true, 16);
    if (!is_array($data)) {
        fail(400, 'Ongeldige invoer.');
    }
    return $data;
}

/* ---------- Sessies ---------- */

function cookiePath(): string
{
    $dir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    return $dir === '' ? '/' : $dir;
}

function cookieOptions(int $expires): array
{
    return [
        'expires'  => $expires,
        'path'     => cookiePath(),
        'secure'   => isHttps(),
        'httponly' => true,
        'samesite' => 'Strict',
    ];
}

/** Maakt een nieuwe sessie (nieuw token bij elke login) en geeft de eindtijd terug. */
function startSession(int $userId): int
{
    $now = time();
    $expires = $now + sessionTtl();
    $token = bin2hex(random_bytes(32));
    db()->prepare('DELETE FROM rancune_sessions WHERE expires_at < ?')->execute([$now]);
    db()->prepare('DELETE FROM rancune_attempts WHERE at < ?')->execute([$now - 86400]);
    db()->prepare('INSERT INTO rancune_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        ->execute([hash('sha256', $token), $userId, $now, $expires]);
    setcookie(SESSION_COOKIE, $token, cookieOptions($expires));
    return $expires;
}

function currentSession(): ?array
{
    $token = $_COOKIE[SESSION_COOKIE] ?? '';
    if (!is_string($token) || !preg_match('/^[a-f0-9]{64}$/', $token)) {
        return null;
    }
    $st = db()->prepare(
        'SELECT s.user_id, s.expires_at, u.name
           FROM rancune_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ?'
    );
    $st->execute([hash('sha256', $token), time()]);
    $row = $st->fetch();
    return $row ? [
        'user_id'    => (int) $row['user_id'],
        'name'       => (string) $row['name'],
        'expires_at' => (int) $row['expires_at'],
    ] : null;
}

function requireSession(): array
{
    $s = currentSession();
    if (!$s) {
        fail(401, 'Niet ingelogd of sessie verlopen.');
    }
    return $s;
}

function endSession(): void
{
    $token = $_COOKIE[SESSION_COOKIE] ?? '';
    if (is_string($token) && preg_match('/^[a-f0-9]{64}$/', $token)) {
        db()->prepare('DELETE FROM rancune_sessions WHERE token_hash = ?')->execute([hash('sha256', $token)]);
    }
    setcookie(SESSION_COOKIE, '', cookieOptions(time() - 3600));
}

/* ---------- Rem op pogingen ---------- */

function tooManyAttempts(string $kind, string $key, int $limit, int $windowSeconds = 900): bool
{
    $st = db()->prepare('SELECT COUNT(*) FROM rancune_attempts WHERE kind = ? AND k = ? AND at > ?');
    $st->execute([$kind, substr($key, 0, 190), time() - $windowSeconds]);
    return (int) $st->fetchColumn() >= $limit;
}

function recordAttempt(string $kind, string $key): void
{
    db()->prepare('INSERT INTO rancune_attempts (kind, k, at) VALUES (?, ?, ?)')
        ->execute([$kind, substr($key, 0, 190), time()]);
}

function clearAttempts(string $kind, string $key): void
{
    db()->prepare('DELETE FROM rancune_attempts WHERE kind = ? AND k = ?')->execute([$kind, substr($key, 0, 190)]);
}

/* ---------- Validatie van gegevens ---------- */

function validId(mixed $v): bool
{
    return is_string($v) && preg_match('/^[A-Za-z0-9]{1,32}$/', $v) === 1;
}

function validTime(mixed $v): bool
{
    return is_int($v) && $v >= 0 && $v < 32503680000000; // t/m het jaar 3000, in milliseconden
}

function cleanPlayer(mixed $p): array
{
    if (!is_array($p) || !validId($p['id'] ?? null) || !is_string($p['name'] ?? null)) {
        fail(400, 'Ongeldige speler.');
    }
    $name = trim((string) preg_replace('/\s+/u', ' ', $p['name']));
    if ($name === '' || mb_strlen($name) > 24) {
        fail(400, 'Een spelersnaam is 1 tot 24 tekens.');
    }
    return ['id' => $p['id'], 'name' => $name];
}

function cleanGame(mixed $g): array
{
    if (!is_array($g) || !validId($g['id'] ?? null) || !validTime($g['start'] ?? null)) {
        fail(400, 'Ongeldig potje.');
    }
    $end = $g['end'] ?? null;
    if ($end !== null && !validTime($end)) {
        fail(400, 'Ongeldig potje (eindtijd).');
    }
    $outcome = $g['outcome'] ?? null;
    if ($outcome !== null && !in_array($outcome, OUTCOMES, true)) {
        fail(400, 'Ongeldig potje (uitslag).');
    }
    $opponents = $g['opponents'] ?? null;
    $events = $g['events'] ?? null;
    if (!is_array($opponents) || !is_array($events) || count($opponents) > 12 || count($events) > 5000) {
        fail(400, 'Ongeldig potje (inhoud).');
    }
    foreach ($opponents as $o) {
        if (!validId($o)) {
            fail(400, 'Ongeldig potje (tegenstander).');
        }
    }
    $cleanEvents = [];
    foreach ($events as $e) {
        if (!is_array($e) || !validId($e['id'] ?? null) || !validId($e['p'] ?? null) || !validTime($e['t'] ?? null)
            || !in_array($e['type'] ?? null, TYPES, true)
            || !is_int($e['n'] ?? null) || $e['n'] < 1 || $e['n'] > 10000) {
            fail(400, 'Ongeldig potje (schade).');
        }
        $cleanEvents[] = ['id' => $e['id'], 't' => $e['t'], 'p' => $e['p'], 'type' => $e['type'], 'n' => $e['n']];
    }
    return [
        'id'        => $g['id'],
        'start'     => $g['start'],
        'end'       => $end,
        'outcome'   => $outcome,
        'opponents' => array_values($opponents),
        'events'    => $cleanEvents,
    ];
}

function idList(mixed $v, int $max): array
{
    if ($v === null) {
        return [];
    }
    if (!is_array($v) || count($v) > $max) {
        fail(400, 'Ongeldige lijst.');
    }
    foreach ($v as $id) {
        if (!validId($id)) {
            fail(400, 'Ongeldige id.');
        }
    }
    return array_values($v);
}
