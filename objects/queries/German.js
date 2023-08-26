/* eslint-disable max-len */

export default (data) =>
  [
    `Allgemeine Informationen:`,
    `- Ziel: Den Inhalt eines in ${data.source} geschriebenen Buches ins ${data.destination} übersetzen`,
    `Übersetzungsanforderungen:`,
    `- Der Inhalt wird im JSON-Format dargestellt`,
    `- Nur die Werte des JSON sollen übersetzt werden`,
    `- JSON-Schlüssel, einschließlich Dateipfaden und UUIDs, dürfen nicht verändert werden`,
    `- Abstände innerhalb von Zeichenketten müssen beibehalten werden`,
    `- Die Struktur des übersetzten JSON muss der des Originals entsprechen`,
    `Buchdetails:`,
    `- Name: ${data.book_title}`,
    `- Geschrieben von: ${data.book_author}`,
    `Zu übersetzender Inhalt:`,
    JSON.stringify(data.content),
  ].join('\n');
