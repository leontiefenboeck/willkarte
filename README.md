# willkarte 🗺️

Immobilien-Inserate von willhaben.at auf einer Karte.

Filter wie gewohnt auf willhaben setzen, dann auf **🗺 Karte** klicken — jede Wohnung
bzw. jedes Haus aus der Suche erscheint als Preis-Pin auf einer interaktiven Karte.

![Alle Inserate der Suche als Preis-Pins auf der Karte](screenshots/uebersicht.png)

Beim Darüberfahren öffnet sich ein Vorschaufenster mit Fotos, Größe, Zimmern und
Adresse; ein Klick führt zum Inserat. Über den Stern lassen sich Inserate
direkt von der Karte aus zur Merkliste hinzufügen oder entfernen (dafür muss man bei
willhaben angemeldet sein); gemerkte Inserate sind auf der Karte goldfarben markiert.

![Vorschaufenster mit Fotogalerie, Preis, Größe, Adresse und Merkliste-Stern](screenshots/vorschau.png)

## Installation

Diesen Ordner als Zip donwloaden und entpacken oder Repo clonen. Dann je nach Browser:

### Chromium-based (Chrome, Edge, Brave...)

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

## Hinweis zur Genauigkeit der Positionen

Die Koordinaten stammen direkt von willhaben — willkarte zeichnet sie nur ein.
**Nicht jedes Inserat liegt exakt an der richtigen Stelle.** Vor allem dort, wo keine
genaue Adresse angegeben ist, sondern nur z. B. eine Postleitzahl oder ein Bezirk,
setzt willhaben die Koordinaten irgendwo in dieses Gebiet (oft in dessen Mitte).
Solche Inserate können also einige Straßenzüge danebenliegen — mehrere Inserate
landen dann auch gerne auf demselben Punkt. Die Karte ist damit gut für den
Überblick, aber die genaue Lage bitte immer im Inserat selbst prüfen.

## Attribution

Kartendaten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende,
Tiles von [OpenFreeMap](https://openfreemap.org). Gebaut mit
[Leaflet](https://leafletjs.com) und [MapLibre GL](https://maplibre.org).
Inseratsdaten von [willhaben.at](https://www.willhaben.at).
