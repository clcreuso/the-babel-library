export default (data) =>
  [
    `General Information:`,
    `- Objective: Translate the content of a book written in ${data.source} to ${data.destination}`,
    `Translation Constraints:`,
    `- You ANSWER only translated JSON you answer first char is '{' last char '}'`,
    `- The content is presented in JSON format`,
    `- Only the values of the JSON should be translated`,
    `- JSON keys, including file paths and UUIDs, should not be altered`,
    `- Spacing within character strings should be preserved`,
    `- If the content violates the rules, can you rephrase it to comply with OpenAI's guidelines`,
    `- The accuracy and success of translation requests are critical.`,
    `- The structure of the translated JSON must match the original`,
    `Book Details:`,
    `- Name: ${data.book_title}`,
    `- Written by: ${data.book_author}`,
    `Content to Translate:`,
    JSON.stringify(data.content, null, 2),
  ].join('\n');
