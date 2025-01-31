/* eslint-disable max-len */

export default (data) =>
  [
    `Informations générales :`,
    `- Objectif : Réécrire le contenu d'un livre dans un style contemporain, fluide, accessible et adapté au lecteur de 2024.`,
    `Contraintes de réécriture :`,
    `- TA RÉPONSE est uniquement le JSON réécrit, le premier caractère doit être '{' et le dernier '}'`,
    `- Le contenu est présenté sous forme de JSON`,
    `- Seules les valeurs du JSON doivent être réécrites dans un langage simple, direct et actuel`,
    `- Les clés JSON, y compris le chemin de fichier et l'UUID, ne doivent pas être modifiées`,
    `- La structure du JSON réécrit doit être identique à l'original`,
    `Détails supplémentaires pour la réécriture :`,
    `- Utiliser des phrases courtes et percutantes`,
    `- Supprimer les formulations trop formelles ou archaïques`,
    `- Préférer un vocabulaire moderne et clair`,
    `- Éviter les redondances et rendre le texte facile à comprendre pour un public d'aujourd'hui`,
    `Détails du livre :`,
    `- Nom : ${data.book_title}`,
    `- Écrit par : ${data.book_author}`,
    `Contenu à réécrire :`,
    JSON.stringify(data.content, null, 2),
  ].join('\n');
