<div align="center">
   <h1 align="center">The Babel Library</h1>
   <br>
   <img src="/images/cover.png" width="50%">
</div>

<br>

   
The Babel Library is a Node.js script that translates EPUB files from one language to another using the OpenAI API. It leverages the power of artificial intelligence to provide automated translation capabilities for EPUB books.

## Prerequisites

Before running the script, make sure you have the following dependencies installed:

- Node.js (version 14 or higher)
- npm (Node Package Manager)

## Configuration

1. Clone the repository and navigate to the project directory.

2. Install the required dependencies by running the following command:

```
   npm install
```

3. Create a `.env` file in the project directory.

4. Open the `.env` file and add the following configuration variables:

```
   OPEN_AI_ORG=your_openai_organization_id
   OPEN_AI_KEY=your_openai_api_key
```

   Replace `your_openai_organization_id` and `your_openai_api_key` with your actual OpenAI organization ID and API key. These credentials are required to access the OpenAI API for translation.

## Usage

To translate an EPUB file, update the `script.js` file with the desired parameters:

```javascript
const translationParams = {
  ...
  source: 'English', // Source language of the EPUB file
  destination: 'French', // Destination language for translation
};
```

Specify the source language and destination language for translation as desired.

Run the script by executing the following command:

```
node script.js path/to/your/file.epub
```

The script will translate the EPUB file and create a translated version in the destination language.

## Notes

    - JSON parsing errors (API response) are not serious.
    - If an error persists, you will either need to lower the value of MAX_TOKENS or 
    manually add the translation to ./db/Database.json.
    - For languages like Chinese, it is possible that certain fields are not translated.
    In that case, you will need to remove them from ./db/Database.json and rerun the 
    script, or translate them manually and modify them in ./db/Database.json.
    - Fix: vérification de cohérence (ratio mots et caractères), traduction macro (regroupement de paragraphe)
    - Version stable: à partir du 5 août 2023
    - Documentation complète: à venir...

## License

This project is licensed under the MIT License. Feel free to modify and use it according to your needs.

## Disclaimer

Please note that this script relies on the OpenAI API for translation. Make sure you comply with the OpenAI usage guidelines and any applicable terms and conditions.
