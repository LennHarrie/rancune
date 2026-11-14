-- Rancune Counter: databaseschema (MySQL 5.7+ / MariaDB 10.3+)
--
-- Draait in DEZELFDE database als de Exploding Kraken-toernooisite: de logins komen uit de
-- bestaande tabel `users`. Importeer dit bestand in phpMyAdmin nadat install.sql van het
-- toernooi is geïmporteerd. Alle tabellen beginnen met rancune_ zodat ze niets raken van EK.

-- Sessies: alleen de hash van het token staat in de database. expires_at is een absolute
-- eindtijd (unix-tijd), 24 uur na het inloggen, en wordt nooit verlengd.
CREATE TABLE IF NOT EXISTS rancune_sessions (
  token_hash CHAR(64)     NOT NULL PRIMARY KEY,
  user_id    INT          NOT NULL,
  created_at INT UNSIGNED NOT NULL,
  expires_at INT UNSIGNED NOT NULL,
  KEY idx_expires (expires_at),
  CONSTRAINT fk_rancune_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Tegenstanders per gebruiker. n bewaart de volgorde waarin ze zijn toegevoegd.
CREATE TABLE IF NOT EXISTS rancune_players (
  n       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT             NOT NULL,
  id      VARCHAR(32)     NOT NULL,
  name    VARCHAR(24)     NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE KEY uq_n (n),
  CONSTRAINT fk_rancune_players_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Eén rij per potje; data bevat het potje als JSON (tegenstanders + alle schade-registraties).
CREATE TABLE IF NOT EXISTS rancune_games (
  user_id    INT             NOT NULL,
  id         VARCHAR(32)     NOT NULL,
  start_at   BIGINT UNSIGNED NOT NULL,
  data       MEDIUMTEXT      NOT NULL,
  updated_at INT UNSIGNED    NOT NULL,
  PRIMARY KEY (user_id, id),
  KEY idx_user_start (user_id, start_at),
  CONSTRAINT fk_rancune_games_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Mislukte inlogpogingen, voor de rem tegen het raden van wachtwoorden.
CREATE TABLE IF NOT EXISTS rancune_attempts (
  id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(16)     NOT NULL,
  k    VARCHAR(190)    NOT NULL,
  at   INT UNSIGNED    NOT NULL,
  KEY idx_lookup (kind, k, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- De "grap" van een beheerder: schade die iemand anders registreert voor een van de opgegeven
-- namen telt maar half. Alleen accounts met rol admin mogen dit zetten (dat wordt in de API afgedwongen).
CREATE TABLE IF NOT EXISTS rancune_prank (
  user_id    INT          NOT NULL PRIMARY KEY,
  enabled    TINYINT(1)   NOT NULL DEFAULT 0,
  names      VARCHAR(500) NOT NULL DEFAULT '[]',
  updated_at INT UNSIGNED NOT NULL,
  CONSTRAINT fk_rancune_prank_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
