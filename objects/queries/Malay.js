/* eslint-disable max-len */

export default (data) =>
  [
    `Maklumat Am:`,
    `- Objektif: Terjemahkan kandungan buku yang ditulis dalam ${data.source} ke ${data.destination}`,
    `Sekatan Terjemahan:`,
    `- Kandungan disajikan dalam format JSON`,
    `- Hanya nilai JSON yang harus diterjemahkan`,
    `- Kunci JSON, termasuk laluan fail dan UUID, tidak harus diubah`,
    `- Jarak dalam rentetan karakter harus dikekalkan`,
    `- Struktur JSON yang diterjemahkan harus sepadan dengan asal`,
    `Butiran Buku:`,
    `- Nama: ${data.book_title}`,
    `- Ditulis oleh: ${data.book_author}`,
    `Kandungan untuk Diterjemah:`,
    JSON.stringify(data.content, null, 2),
  ].join('\n');
