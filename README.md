# G.B Lead Control Center

Internes Lead-Management mit Supabase Auth, PostgreSQL und der Reonic Edge Function. Die öffentliche GitHub-Pages-Seite lädt nach erfolgreicher Anmeldung die Daten des freigeschalteten Admin-Kontos.

## Bereitstellung

1. Die Migrationen unter `supabase/migrations` in Reihenfolge anwenden. Im bestehenden Projekt sind diese Migrationen bereits angewendet.
2. `supabase/data/de-postal.csv` als CSV in `public.de_postal_codes` importieren. Im bestehenden Projekt sind die 10.815 Datensätze bereits geladen.
3. `reonic-sync-users` bereitstellen und `REONIC_API_KEY` in Supabase als Secret setzen. Der Handler prüft den Supabase-Benutzer und dessen Mitgliedschaft in `app_admins` serverseitig.
4. Die Dashboard-Adresse für Passwort-Links in Supabase Auth erlauben. Der Browser verwendet die Projektadresse und den öffentlichen Publishable Key in `app.js`.
5. Nach Freigabe die Website über GitHub Pages veröffentlichen.

## Funktionsprüfung

- Als freigeschalteter Admin anmelden und neu laden. Die Sitzung und die gespeicherten Daten müssen wieder verfügbar sein.
- Reonic synchronisieren und bei einem Verkäufer die deutsche PLZ und den Radius ergänzen. Den Verkäufer freischalten. Erneuter Import muss PLZ, Radius und Freigabe bewahren.
- Einen Test-Lead mit bekannter deutscher PLZ speichern. Passende Verkäufer prüfen und den Lead zuweisen. Dieselbe Zuweisung darf nur einmal gespeichert werden.
- Bestellung erfassen, die optionale Verknüpfung bei einer neuen Zuweisung auswählen und den Verlauf nach Neuladen prüfen.

## PLZ-Daten

[GeoNames Postal Codes](https://www.geonames.org/export/zip/) unter [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Die Datei enthält deutsche PLZ mit gemittelten Koordinaten der jeweils höchsten verfügbaren Genauigkeitsstufe. Die Verteilung nutzt die Luftlinie zwischen diesen PLZ-Koordinaten.
