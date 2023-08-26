export default (data) =>
  [
    `Informations générales :`,
    `- Objectif : Traduire le contenu d'un livre écrit en ${data.source} en ${data.destination}`,
    `Contraintes de traduction :`,
    `- Le contenu est présenté sous forme de JSON`,
    `- Seules les valeurs du JSON doivent être traduites`,
    `- Les clés JSON, y compris le chemin de fichier et l'UUID, ne doivent pas être touchées`,
    `- Les espacements au sein des chaînes de caractères doivent être conservés`,
    `- La structure du JSON traduit doit être identique à l'original`,
    `Détails du livre :`,
    `- Nom : ${data.book_title}`,
    `- Écrit par : ${data.book_author}`,
    `Contenu à traduire :`,
    JSON.stringify(data.content),
  ].join('\n');
