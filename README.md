# willkarte 🗺️

Immobilien-Inserate von willhaben.at auf einer Karte.

Filter wie gewohnt auf willhaben setzen, dann auf **🗺 Karte** klicken — jede Wohnung
bzw. jedes Haus aus der Suche erscheint als Preis-Pin auf einer interaktiven Karte.
Beim Darüberfahren öffnet sich ein Vorschaufenster mit Fotos, Größe, Zimmern und
Adresse; ein Klick führt direkt zum Inserat. Inserate auf der Merkliste sind mit
einem ★ markiert, und über den Stern im Vorschaufenster lassen sich Inserate direkt
von der Karte aus zur Merkliste hinzufügen oder entfernen (dafür muss man bei
willhaben angemeldet sein).

## Hinweis zur Genauigkeit der Positionen

Die Koordinaten stammen direkt von willhaben — willkarte zeichnet sie nur ein.
**Nicht jedes Inserat liegt exakt an der richtigen Stelle.** Vor allem dort, wo keine
genaue Adresse angegeben ist, sondern nur z. B. eine Postleitzahl oder ein Bezirk,
setzt willhaben die Koordinaten irgendwo in dieses Gebiet (oft in dessen Mitte).
Solche Inserate können also einige Straßenzüge danebenliegen — mehrere Inserate
landen dann auch gerne auf demselben Punkt. Die Karte ist damit gut für den
Überblick, aber die genaue Lage bitte immer im Inserat selbst prüfen.

## Installation

### Chrome / Edge / Brave

1. `chrome://extensions` öffnen
2. **Entwicklermodus** aktivieren (rechts oben)
3. Auf **Entpackte Erweiterung laden** klicken und den Ordner **`src`** auswählen

### Firefox

Funktioniert nur, wenn in `about:config` der Wert `xpinstall.signatures.required`
auf `false` gesetzt ist (möglich in ESR-, Nightly- oder Developer-Versionen).

1. `about:addons` öffnen
2. ⚙️ → **Add-on aus Datei installieren…**
3. **`willkarte-firefox.xpi`** auswählen

---

Danach eine beliebige Immobiliensuche auf willhaben öffnen und rechts unten auf
**🗺 Karte** klicken. Falls der Button fehlt, die Seite neu laden.

## Attribution

Kartendaten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende,
Tiles von [OpenFreeMap](https://openfreemap.org). Gebaut mit
[Leaflet](https://leafletjs.com) und [MapLibre GL](https://maplibre.org).
Inseratsdaten von [willhaben.at](https://www.willhaben.at).
