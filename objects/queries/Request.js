/* eslint-disable import/no-extraneous-dependencies */
/* eslint-disable max-len */

import dotenv from 'dotenv';

import Anthropic from '@anthropic-ai/sdk';

import { Configuration, OpenAIApi } from 'openai';

dotenv.config();

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_KEY,
});

const OpenAI = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPENAI_KEY,
    organization: process.env.OPENAI_ORG,
  })
);

const getRequestContent = (data) =>
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
    `RIEN D'AUTRE !!`,
    `Détails :`,
    `- Titre : ${data.book_title}`,
    `- Auteur : ${data.book_author}`,
    `Contenu (focus uniquement sur ce texte) :`,
    data.content,
  ].join('\n');

const sendRequestOpenAI = (data) =>
  OpenAI.createChatCompletion({
    model: data.model,
    messages: [
      {
        role: 'user',
        content: getRequestContent({
          book_title: data.title,
          book_author: data.creator,
          content: data.content,
        }),
      },
    ],
  });

const sendRequestAnthropic = (data) =>
  client.messages.create({
    model: data.model,
    max_tokens: 3000,
    messages: [
      {
        role: 'user',
        content: getRequestContent({
          book_title: data.title,
          book_author: data.creator,
          content: data.content,
        }),
      },
    ],
  });

export default (data) => {
  if (data.model.includes('gpt'))
    return sendRequestOpenAI(data).then((res) => res.data.choices[0].message.content);

  if (data.model.includes('claude'))
    return sendRequestAnthropic(data).then((res) => res.content[0].text);

  return Promise.resolve(false);
};
