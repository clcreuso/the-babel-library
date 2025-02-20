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

const getRequestCategories = (data) => {
  if (data.language === 'French')
    return [
      `Objectif : Envoyer des categorie en français en fonction d'un theme, au format Array.`,
      `Contexte : Écriture future d'un dictionnaire orienté sur le vocabulaire en fonction d'un theme`,
      `Theme: ${data.theme}`,
      `Conditions :`,
      `- Une categorie est tres proche du theme degré 1`,
      `- Une categorie est un seul mot tres general et simple`,
      `- Pas de répétitio`,
      `- Au minimum 20 categories`,
      `Réponse attendue (en JSON) :`,
      `{ "categories": [String, String...] }`,
    ].join('\n');

  if (data.language === 'English')
    return [
      `Structured HTML summary of a book section.`,
      `Goal: Create a clear summary in English, in HTML format, with a ratio of about 1 summary word for every 5 original words.`,
      `Conditions:`,
      `- If the content is relevant (introduction, chapter, etc.), produce a structured summary in HTML.`,
      `- If the content is irrelevant (index, author, acknowledgments, blank pages, etc.), respond with: { "filename": undefined, "content": undefined }.`,
      `Requirements:`,
      `- At least 200 words in the content to generate a summary.`,
      `- No introduction or redundant content about the book title.`,
      `- Use HTML tags (<h>, <p>, <b>, <i>, <br>) without \n.`,
      `Expected response (in JSON):`,
      `{`,
      `     "filename": "Adapted_Title.html",`,
      `     "content": "<h1>Content Title</h1><p>Intro Content</p><h2>Point #1 Title</h2><p>Point #1 Summary</p>..."`,
      `}`,
      `NOTHING ELSE!!`,
      `Details:`,
      `- Title: ${data.title}`,
      `- Author: ${data.author}`,
      `Content (focus only on this text):`,
      data.content,
    ].join('\n');

  if (data.language === 'Thai')
    return [
      `สรุป HTML แบบมีโครงสร้างของส่วนหนึ่งในหนังสือ`,
      `เป้าหมาย: สร้างสรุปที่ชัดเจนในภาษาไทย ในรูปแบบ HTML โดยมีอัตราส่วนประมาณ 1 คำสรุปต่อทุกๆ 5 คำต้นฉบับ`,
      `เงื่อนไข:`,
      `- หากเนื้อหาเกี่ยวข้อง (เช่น บทนำ บทในหนังสือ เป็นต้น) ให้สร้างสรุปแบบมีโครงสร้างใน HTML`,
      `- หากเนื้อหาไม่เกี่ยวข้อง (เช่น สารบัญ ผู้เขียน คำขอบคุณ หน้ากระดาษเปล่า เป็นต้น) ให้ตอบกลับด้วย: { "filename": undefined, "content": undefined }`,
      `ข้อกำหนด:`,
      `- มีเนื้อหาอย่างน้อย 200 คำเพื่อสร้างสรุป`,
      `- ไม่ต้องมีบทนำหรือเนื้อหาที่ซ้ำซ้อนเกี่ยวกับชื่อหนังสือ`,
      `- ใช้แท็ก HTML (<h>, <p>, <b>, <i>, <br>) โดยไม่มี \n`,
      `รูปแบบการตอบกลับที่คาดหวัง (ใน JSON):`,
      `{`,
      `     "filename": "Adapted_Title.html",`,
      `     "content": "<h1>ชื่อเนื้อหา</h1><p>บทนำ</p><h2>หัวข้อ #1</h2><p>สรุปหัวข้อ #1</p>..."`,
      `}`,
      `ไม่มีข้อความอื่นเพิ่มเติม!!`,
      `รายละเอียด:`,
      `- ชื่อเรื่อง: ${data.title}`,
      `- ผู้เขียน: ${data.author}`,
      `เนื้อหา (ให้เน้นเฉพาะข้อความนี้):`,
      data.content,
    ].join('\n');

  return undefined;
};

const getRequestChapter = (data) => {
  if (data.language === 'French')
    return [
      `Objectif : Créer un Dictionnaire Français / Anglais, au format HTML.`,
      `Objectif : Enrichir la comprhension de la langue anglais a partir d'un theme`,
      `Contexte : Le Dictionnaire est générer a partir d'un theme`,
      `Theme: ${data.theme} | Categorie ${data.category}`,
      `Conditions :`,
      `- Pas de titre`,
      `- RELATION avec le THEME`,
      `- RELATION avec la CATEGORIE`,
      `- Utiliser uniquement ces balises : <table>, <tr>, <th>, <td>, <p>, <b>, <br>`,
      `Strucutre HTML :`,
      `- Vocabulaires (RELATION avec THEME et CATEGORIE): Français | Anglais (minimum 25 mots)`,
      `- Exemples (RELATION  avec THEME et CATEGORIE): Expressions ou Formulations Anglaise`,
      `Réponse attendue (en JSON) :`,
      `{ "content": "HTML" }`,
    ].join('\n');

  if (data.language === 'English')
    return [
      `Structured HTML summary of a book section.`,
      `Goal: Create a clear summary in English, in HTML format, with a ratio of about 1 summary word for every 5 original words.`,
      `Conditions:`,
      `- If the content is relevant (introduction, chapter, etc.), produce a structured summary in HTML.`,
      `- If the content is irrelevant (index, author, acknowledgments, blank pages, etc.), respond with: { "filename": undefined, "content": undefined }.`,
      `Requirements:`,
      `- At least 200 words in the content to generate a summary.`,
      `- No introduction or redundant content about the book title.`,
      `- Use HTML tags (<h>, <p>, <b>, <i>, <br>) without \n.`,
      `Expected response (in JSON):`,
      `{`,
      `     "filename": "Adapted_Title.html",`,
      `     "content": "<h1>Content Title</h1><p>Intro Content</p><h2>Point #1 Title</h2><p>Point #1 Summary</p>..."`,
      `}`,
      `NOTHING ELSE!!`,
      `Details:`,
      `- Title: ${data.title}`,
      `- Author: ${data.author}`,
      `Content (focus only on this text):`,
      data.content,
    ].join('\n');

  if (data.language === 'Thai')
    return [
      `สรุป HTML แบบมีโครงสร้างของส่วนหนึ่งในหนังสือ`,
      `เป้าหมาย: สร้างสรุปที่ชัดเจนในภาษาไทย ในรูปแบบ HTML โดยมีอัตราส่วนประมาณ 1 คำสรุปต่อทุกๆ 5 คำต้นฉบับ`,
      `เงื่อนไข:`,
      `- หากเนื้อหาเกี่ยวข้อง (เช่น บทนำ บทในหนังสือ เป็นต้น) ให้สร้างสรุปแบบมีโครงสร้างใน HTML`,
      `- หากเนื้อหาไม่เกี่ยวข้อง (เช่น สารบัญ ผู้เขียน คำขอบคุณ หน้ากระดาษเปล่า เป็นต้น) ให้ตอบกลับด้วย: { "filename": undefined, "content": undefined }`,
      `ข้อกำหนด:`,
      `- มีเนื้อหาอย่างน้อย 200 คำเพื่อสร้างสรุป`,
      `- ไม่ต้องมีบทนำหรือเนื้อหาที่ซ้ำซ้อนเกี่ยวกับชื่อหนังสือ`,
      `- ใช้แท็ก HTML (<h>, <p>, <b>, <i>, <br>) โดยไม่มี \n`,
      `รูปแบบการตอบกลับที่คาดหวัง (ใน JSON):`,
      `{`,
      `     "filename": "Adapted_Title.html",`,
      `     "content": "<h1>ชื่อเนื้อหา</h1><p>บทนำ</p><h2>หัวข้อ #1</h2><p>สรุปหัวข้อ #1</p>..."`,
      `}`,
      `ไม่มีข้อความอื่นเพิ่มเติม!!`,
      `รายละเอียด:`,
      `- ชื่อเรื่อง: ${data.title}`,
      `- ผู้เขียน: ${data.author}`,
      `เนื้อหา (ให้เน้นเฉพาะข้อความนี้):`,
      data.content,
    ].join('\n');

  return undefined;
};

const sendRequestContent = (data) => {
  if (data.type === 'categories') {
    return getRequestCategories(data);
  }

  if (data.type === 'chapter') {
    return getRequestChapter(data);
  }

  return Promise.resolve(false);
};

const sendRequestOpenAI = (data) =>
  OpenAI.createChatCompletion({
    model: data.model,
    messages: [{ role: 'user', content: sendRequestContent(data) }],
  });

const sendRequestAnthropic = (data) =>
  client.messages.create({
    model: data.model,
    max_tokens: 8192,
    messages: [{ role: 'user', content: sendRequestContent(data) }],
  });

export default (data) => {
  if (data.type === 'cover')
    return OpenAI.createImage({
      model: 'dall-e-3',
      prompt: [
        `Couverture de dictionnaire Français-Anglais sur le thème "${data.theme}".`,
        `Design abstrait, graphique et moderne.`,
        `Pas de représentation de livre physique, pas de pages, pas de reliure.`,
        `Illustration simple avec formes géométriques, couleurs sobres et texture légère.`,
        data.content,
      ].join('\n'),
      n: 1,
      size: '1024x1792',
      response_format: 'b64_json',
    });

  if (data.model.includes('gpt'))
    return sendRequestOpenAI(data).then((res) => res.data.choices[0].message.content);

  if (data.model.includes('claude'))
    return sendRequestAnthropic(data).then((res) => res.content[0].text);

  return Promise.resolve(false);
};
