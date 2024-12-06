/* eslint-disable max-len */

export default (data) =>
  [
    `Résumé en HTML d'une partie de livre.`,
    `- Objectif : Rédiger un résumé (pas trop résumé) en français du contenu fourni, dans le style d'un livre *Summarized for Busy People*, et structuré en HTML.`,
    `Conditions :`,
    `- Si le contenu est pertinent (par exemple, introduction, chapitres informatifs), produire un résumé structuré en HTML.`,
    `- Si le contenu est non pertinent (index, copyright, pages blanches, etc.), répondre avec filename et content définis sur undefined.`,
    `Réponse attendue (En JSON) :`,
    `- un nom de fichier adapté au contexte (par exemple, "Introduction.html", "Chapitre_1.html" ou "Un_titre_plus_specifique.html"...)`,
    `- le résumé structuré en HTML (header <h></h>, paragaphe <p></p>, bold <b></b>, italique <i></i>...) dans le champ content.`,
    `- le résumé ne doit pas etre trop resumé essaie d'avoir un ratio d'environ 1 mot pour 5`,
    `- le résumé doit etre fait a partir d'un minimum de text si le contenue fait moi de 200 mots ce n'est pas interessant`,
    `- pas de \n utilse <br>`,
    `Modèle de Réponse JSON :`,
    `{ "filename": "Introduction.html", "content": "<h1>Introduction</h1><p>Ceci est un résumé clair et concis de l'introduction.</p>..." }`,
    `Détails du livre :`,
    `- Nom : ${data.book_title}`,
    `- Écrit par : ${data.book_author}`,
    `Contenu de la partie du livre (focus uniquement sur ce qui va suivre)):`,
    data.content,
    `Fin du Contenu de la partie du livre.`,
  ].join('\n');
