/* eslint-disable max-len */

export default (data) =>
  [
    `Résumé structuré en HTML d'une partie de livre.`,
    `Objectif : Créer un résumé clair en français, au format HTML, avec un ratio d'environ 1 mot résumé pour 5 mots originaux.`,
    `Conditions :`,
    `- Si le contenu est pertinent (introduction, chapitre, etc.), produire un résumé structuré en HTML.`,
    `- Si le contenu est non pertinent (index, auteur, remerciement, pages blanches, etc.), répondre : { "filename": undefined, "content": undefined }.`,
    `Exigences :`,
    `- Minimum 200 mots dans le contenu pour générer un résumé.`,
    `- Pas d'introduction ou de contenu redondant sur le titre du livre.`,
    `- Utiliser des balises HTML (<h>, <p>, <b>, <i>, <br>) sans \n.`,
    `Réponse attendue (en JSON) :`,
    `{`,
    `     "filename": "Titre_adapté.html",`,
    `     "content": "<h1>Titre Contenu</h1><p>Intro Contenue</p><h2>Titre Point #1</h2><p>Resumé Point #1</p>..."`,
    `}`,
    `Détails :`,
    `- Titre : ${data.book_title}`,
    `- Auteur : ${data.book_author}`,
    `Contenu (focus uniquement sur ce texte) :`,
    data.content,
  ].join('\n');
