export default (data) =>
  [
    `المعلومات العامة:`,
    `- الهدف: ترجمة محتوى كتاب مكتوب بـ${data.source} إلى ${data.destination}`,
    `قيود الترجمة:`,
    `- يتم عرض المحتوى بتنسيق JSON`,
    `- يجب ترجمة قيم JSON فقط`,
    `- لا يجب تغيير مفاتيح JSON، بما في ذلك مسارات الملفات وUUID`,
    `- يجب الحفاظ على المسافات داخل الجمل`,
    `- يجب أن تكون هيكلية JSON المترجمة مطابقة للأصل`,
    `تفاصيل الكتاب:`,
    `- الاسم: ${data.book_title}`,
    `- كتب بواسطة: ${data.book_author}`,
    `المحتوى المراد ترجمته:`,
    JSON.stringify(data.content),
  ].join('\n');
