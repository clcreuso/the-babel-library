export default (data) =>
  [
    `Información general:`,
    `- Objetivo: Traducir el contenido de un libro escrito en ${data.source} a ${data.destination}`,
    `Restricciones de traducción:`,
    `- El contenido se presenta en formato JSON`,
    `- Solo los valores del JSON deben ser traducidos`,
    `- Las claves del JSON, incluidos los caminos de archivo y los UUID, no deben ser alteradas`,
    `- Los espacios dentro de las cadenas de caracteres deben ser preservados`,
    `- La estructura del JSON traducido debe coincidir con la original`,
    `Detalles del libro:`,
    `- Nombre: ${data.book_title}`,
    `- Escrito por: ${data.book_author}`,
    `Contenido a traducir:`,
    JSON.stringify(data.content, null, 2),
  ].join('\n');
