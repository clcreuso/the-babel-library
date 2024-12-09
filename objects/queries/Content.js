/* eslint-disable max-len */
export default (data) => {
  if (data.language === 'French')
    return [
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
      `- Title: ${data.book_title}`,
      `- Author: ${data.book_author}`,
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
      `- ชื่อเรื่อง: ${data.book_title}`,
      `- ผู้เขียน: ${data.book_author}`,
      `เนื้อหา (ให้เน้นเฉพาะข้อความนี้):`,
      data.content,
    ].join('\n');

  return undefined;
};
