# BTC Fun Trader

Spielgeld-Trading mit echten BTC/USD-Live-Kursen als iPhone-PWA. **Kein echtes Geld, keine Accounts, kein Backend.**

- Finger **oben** halten = Long, **unten** halten = Short. Loslassen schließt die Position.
- Einsatz und Hebel (1x bis 100x) unten einstellen, optional 0,05 % Gebühr pro Seite.
- Liquidation, wenn der Verlust den Einsatz erreicht.
- Startkapital 10.000 $, Reset jederzeit, Lifetime-PnL und Statistik bleiben erhalten.
- Kurse: Coinbase Exchange WebSocket (`ticker`, BTC-USD), Fallback Kraken WebSocket v2.
- Alles bleibt lokal im Browser (localStorage).

## Entwicklung

```sh
npm install
npm run dev        # Dev-Server, auch im LAN erreichbar (--host)
npm test           # Unit-Tests (Trade-Mathe, Statistik, Feed-Parser)
npm run build      # Typecheck + Produktions-Build nach dist/
npm run preview    # Build lokal inkl. Service Worker
npm run icons      # PNG-Icons aus public/icons/icon.svg erzeugen (braucht Playwright)
```

`VITE_BASE=/pfad/ npm run build` setzt den Basis-Pfad für Hosting in einem Unterordner.

## Aufbau

| Datei | Aufgabe |
| --- | --- |
| `src/trading.ts` | Reine Trade-Mathe: PnL, Gebühren, Liquidation, Einsatz-Limit |
| `src/store.ts` | Spielstand, Statistik-Aggregate, localStorage |
| `src/feed.ts` | WebSocket Coinbase/Kraken, Reconnect mit Backoff, Stale-Erkennung |
| `src/chart.ts` | Canvas-Chart, 60 fps, Zoom 30 s / 1 min / 5 min |
| `src/touch.ts` | Halten-Geste, Pinch, Multitouch-Sperre, Seiten-Gesten blockieren |
| `src/feedback.ts` | WebAudio-Sounds, Haptik (best effort), Flash |
| `src/stats-view.ts` | Statistik-Screen mit Kontostand-Kurve |
| `public/sw.js` | App-Shell-Cache für Offline-Start |

## Haptik auf dem iPhone

iOS Safari unterstützt die Vibration API nicht. Die App versucht den inoffiziellen
`<input type="checkbox" switch>`-Trick; laut dem Projekt *ios-haptics* funktioniert er nur
von iOS 17.4 bis 26.4. Deshalb gibt es immer zusätzlich Sound und einen kurzen Bildschirm-Flash.
Auf Android wird `navigator.vibrate` genutzt.
