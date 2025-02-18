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

const getRequestChapter = (data) => {
  if (data.language === 'French')
    return [
      `Objectif : Créer un résumé clair et pertinent en français, au format HTML.`,
      `Contexte : Le contenu provient des sous-titres d'une vidéo YouTube.`,
      `Details:`,
      `- Title: ${data.title}`,
      `- Author: ${data.author}`,
      `- Part: ${data.part}`,
      `Conditions :`,
      `- Regarder et analyser l'intégralité du contenu fourni avant de commencer le résumé.`,
      `- Ne pas inclure d'introduction générale, de conclusion ou de digressions anecdotiques.`,
      `- Assurer une écriture fluide et agréable pour le lecteur.`,
      `- Traduire intégralement en français les citations, slogans, maximes, et autres expressions.`,
      `- Part 1/x === Introduction, Part x/x === Conclusion et les autres parties pas de remises en contexte ! Juste Resume !`,
      `Format attendu :`,
      `- Utiliser uniquement ces balises : <h1>, <h2>, <p>, <b>, <i>, <br>.`,
      `- Structurer le contenu en titres et paragraphes pour une lecture claire.`,
      `Réponse attendue (en JSON) :`,
      `{ "content": "HTML" }`,
      `Contenu à résumer :`,
      data.content,
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
  if (data.model.includes('gpt'))
    return sendRequestOpenAI(data).then((res) => res.data.choices[0].message.content);

  if (data.model.includes('claude'))
    return sendRequestAnthropic(data).then((res) => res.content[0].text);

  return Promise.resolve(false);
};
