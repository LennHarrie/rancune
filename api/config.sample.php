<?php
// Kopieer dit bestand naar config.php. config.php komt niet in git.
//
// De database is die van de Exploding Kraken-toernooisite: de logins van die site (tabel `users`)
// worden ook voor deze app gebruikt. Er zijn dus geen eigen accounts of registratie.
return [
    // Optie 1 (handigst): verwijs naar het config.php van het toernooi. De db_*-gegevens
    // worden daar uit gelezen. Bijvoorbeeld als deze map in /toernooi/rancune staat:
    //   'ek_config' => __DIR__ . '/../../config.php',
    'ek_config' => '',

    // Optie 2: zelf invullen (laat ek_config dan leeg). Zelfde gegevens als in het toernooi-config.php.
    'db_host' => 'localhost',
    'db_name' => 'VUL_HIER_DATABASE_NAAM_IN',
    'db_user' => 'VUL_HIER_DATABASE_USER_IN',
    'db_pass' => 'VUL_HIER_WACHTWOORD_IN',

    // Hoe lang een login geldig blijft (uren, vanaf het inloggen; wordt niet verlengd).
    'session_hours' => 24,
];
