# MultiView

Website: https://eflorian136-lang.github.io/twitch-multiview/

Mehrere Twitch-Streams gleichzeitig ansehen: einen beliebigen Live-Stream als Hauptbild waehlen und weitere Streams/Cams dazu einblenden. Laeuft im Browser, am Handy und auf dem Amazon Fire TV Stick (als eigene App oder im Silk-Browser). Gehostet kostenlos ueber GitHub Pages, immer online, kein eigener PC noetig.

## Funktionen

- Kanaele per Name oder Twitch-Link hinzufuegen (max. 9)
- Live-Streams finden (nach Twitch-Anmeldung): gefolgte Kanaele, Top DE, Top weltweit, Suche
- "Hauptbild" setzt einen Stream gross und mit Ton, "Als Cam dazu" fuegt ihn klein dazu
- Layouts: Raster, Spotlight, Bild in Bild, Nur einer
- Ton immer nur auf einem Stream
- Einstellungen stehen im Link (`?c=kanal1,kanal2&l=spotlight&a=kanal1`) und werden lokal gespeichert

## Bedienung mit der Fire-TV-Fernbedienung

| Taste | Funktion |
|---|---|
| Pfeile | Stream auswaehlen |
| OK | Ton/Hauptbild auf diesen Stream, nochmal OK = Vollbild |
| Menue-Taste (oder Pfeil hoch/links am Rand) | Menue oeffnen/schliessen |
| Zurueck | Menue schliessen / Vollbild verlassen / App beenden |

## Fire-TV-App installieren

1. Fire TV: Einstellungen > Mein Fire TV > Entwickleroptionen > Apps unbekannter Herkunft fuer "Downloader" erlauben (Entwickleroptionen erscheinen nach 7x Klick auf "Info > Fire TV Stick").
2. App "Downloader" aus dem Amazon Store installieren.
3. In Downloader diese Adresse eingeben:
   `https://github.com/eflorian136-lang/twitch-multiview/releases/download/tv-app/MultiView.apk`
4. Installieren. "MultiView" erscheint unter "Deine Apps".

Die APK wird bei jeder Aenderung in `android/` automatisch von GitHub Actions gebaut.
Damit Updates ohne Deinstallation gehen, als Repository-Secrets einen festen Schluessel hinterlegen:
`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.

## Live-Stream-Suche aktivieren (Twitch Client-ID)

Twitch gibt Listen von Live-Streams nur mit einer (kostenlosen) Client-ID heraus.

1. https://dev.twitch.tv/console/apps > "Register Your Application"
2. Name: beliebig, OAuth Redirect URL: `https://eflorian136-lang.github.io/twitch-multiview/`, Kategorie: Website Integration, Client-Typ: **Oeffentlich**
3. Client-ID kopieren und im Repository unter Settings > Secrets and variables > Actions > **Variables** als `TWITCH_CLIENT_ID` anlegen (die ID ist nicht geheim).
4. Workflow "Website testen und veroeffentlichen" neu starten.

Anmeldung am Fernseher: "Mit Twitch anmelden" zeigt einen Code, den man am Handy unter twitch.tv/activate eingibt.

## Entwicklung

```
npm test          # Unit- und Browser-Tests (Playwright/Chromium noetig)
npm run serve     # lokal auf http://localhost:8080
```

Fremde Streams werden ueber den offiziellen Twitch-Player eingebettet; Zuschauer zaehlen beim jeweiligen Streamer.
