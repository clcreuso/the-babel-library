/* eslint-disable import/no-extraneous-dependencies */
/* eslint-disable max-len */

import dotenv from 'dotenv';

import Anthropic from '@anthropic-ai/sdk';

import { Configuration, OpenAIApi } from 'openai';

import getRequestContent from './Content.js';

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

const sendRequestOpenAI = (data) =>
  OpenAI.createChatCompletion({
    model: data.model,
    messages: [
      {
        role: 'user',
        content: getRequestContent({
          book_title: data.title,
          book_author: data.creator,
          language: data.language,
          content: data.content,
        }),
      },
    ],
  });

const sendRequestAnthropic = (data) =>
  client.messages.create({
    model: data.model,
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: getRequestContent({
          book_title: data.title,
          book_author: data.creator,
          language: data.language,
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
