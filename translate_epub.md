# Traduire rapidement un EPUB

## Utilisation recommandée

Placer l’EPUB dans le même dossier que ce workflow, puis envoyer ce message dans Codex :

```text
[translate_epub.md](translate_epub.md) "Mon livre.epub" French --profile fast
```

Il s’agit d’une instruction adressée à Codex, pas d’une commande de terminal. Codex lit ce fichier, exécute le pipeline, suit les workers jusqu’à la fin, effectue la passe éditoriale et restitue l’EPUB final.

Chaque livre reçoit son propre dossier avec des noms de fichiers stables :

```text
books/Livre/
├── original.epub
├── translated-fr.epub
├── extracted original/
├── working fr/
└── translation jobs fr/
```

Le titre court du dossier est lu dans les métadonnées de l’EPUB. Il peut être imposé directement dans le message :

```text
[translate_epub.md](translate_epub.md) "Mon livre.epub" French --profile fast --book-name "Titre court"
```

Une copie canonique nommée `original.epub` est rangée dans le dossier du livre et n’est jamais remplacée. Une fois la préparation entièrement réussie, le fichier d’entrée resté hors de `books/` est supprimé. Ajouter `--keep-source` au message Codex pour le conserver exceptionnellement.

Les guillemets extérieurs, caractères invisibles et parenthèses finales vides sont retirés du nom de dossier. Le titre final affiché par les liseuses est ensuite décidé par la passe éditoriale, indépendamment de ce nom technique.

## Pourquoi cette version est plus rapide

L’ancien pipeline confiait à chaque worker la lecture, la modification et la validation complète d’un fichier XHTML par fenêtres de 50 lignes. Le nouveau pipeline extrait d’abord les paragraphes et confie aux workers uniquement leur traduction, sous forme de lots JSON équilibrés.

Les opérations suivantes sont désormais réalisées une seule fois par un programme déterministe :

- extraction et classification de l’EPUB ;
- protection du code, des balises et des liens ;
- réinsertion des traductions ;
- harmonisation des titres et génération de la navigation ;
- relecture éditoriale approfondie des métadonnées par une mission Codex séparée ;
- localisation de la couverture à partir de la couverture originale lorsque Codex fournit `--cover-image` ;
- validation XML et structurelle ;
- reconstruction et contrôle ZIP.

## Étapes du pipeline

Les commandes Python ci-dessous documentent les opérations internes que Codex pilote. Pour un usage normal, le message unique montré plus haut suffit.

### 1. Préparation

```sh
python3 epub_translate.py "livre.epub" French --stage prepare
```

Cette étape crée `books/<titre court>/`, copie la source dans `original.epub`, puis crée les dossiers visibles `extracted original`, `working fr` et `translation jobs fr`. Elle localise le package OPF, classe chaque ressource et extrait les segments traduisibles dans `segments.jsonl`.

### 2. Traduction parallèle

```sh
python3 epub_translate.py "livre.epub" French --stage translate
```

En mode standard, les segments sont regroupés en lots d’environ 6 000 tokens source et traduits par huit `codex exec` simultanés. Le profil rapide utilise dix workers ; tous sont en lecture seule, n’utilisent aucun outil et retournent uniquement du JSON validé par `translation_output.schema.json`.

Chaque ligne de traduction est validée et sauvegardée indépendamment. Si un lot contient quelques erreurs, ses traductions valides sont conservées et seuls les segments invalides sont envoyés dans de petits lots de réparation.

### 3. Réinsertion

```sh
python3 epub_translate.py "livre.epub" French --stage apply
```

Le programme réinsère les traductions dans les emplacements XML d’origine. Les marqueurs `OPEN`, `CLOSE` et `LOCK` garantissent que le balisage inline, les liens et le code restent inchangés.

### 4. Relecture éditoriale et couverture

La traduction en masse n’est pas utilisée comme source de vérité pour le titre. Une mission Codex distincte, avec un raisonnement moyen par défaut, confronte les champs OPF à la page de titre et aux textes liminaires. Elle sépare le titre et le sous-titre, corrige les artefacts, nettoie les caractères invisibles et produit une description ainsi que des sujets cohérents.

```sh
python3 epub_translate.py "livre.epub" French --stage editorial
```

La décision est enregistrée dans `translation jobs fr/editorial/metadata_decision.json`. Le prompt prêt à employer pour l’édition visuelle est enregistré dans `translation jobs fr/editorial/cover_prompt.md`.

Dans Codex, ouvrir la couverture source, effectuer une traduction visuelle rapide en une seule passe avec ce prompt, puis installer directement l’image sans recalculer la décision :

```sh
python3 epub_translate.py "livre.epub" French \
  --stage editorial --resume \
  --cover-image "cover-fr.jpg"
```

Seule la ressource explicitement identifiée comme couverture dans l’OPF peut être remplacée. Toutes les autres images restent strictement préservées. Cette étape met aussi à jour la page de titre, le titre NCX, `calibre:title_sort` et `calibre:subtitle`. Elle préserve l’ISBN, les identifiants et les noms propres qui ne sont pas remis en cause par les sources du livre.

### 5. Validation

```sh
python3 epub_translate.py "livre.epub" French --stage validate
```

Une seule passe compare les structures, attributs, blocs protégés, ressources, métadonnées et documents du spine. La reconstruction est bloquée si une erreur est détectée.

### 6. Reconstruction

```sh
python3 epub_translate.py "livre.epub" French --stage build
```

Le fichier `mimetype` est ajouté en premier sans compression, puis toutes les autres ressources sont compressées. L’intégrité ZIP et l’ordre des membres sont contrôlés avant le remplacement atomique du résultat final.

## Reprendre une traduction

```text
[translate_epub.md](translate_epub.md) "books/Livre/original.epub" French --resume
```

Les traductions déjà présentes dans `translations.jsonl` ne sont pas recalculées. Les segments identiques d’un même livre sont dédupliqués, et la mémoire partagée `books/.translation-memory/fr.json` réutilise ceux rencontrés dans les autres livres tout en tenant compte de la version du glossaire.

## Repartir proprement

```text
[translate_epub.md](translate_epub.md) "livre.epub" French --profile fast --force
```

Les anciens dossiers de travail sont archivés avec un horodatage avant la nouvelle extraction. La copie canonique `books/Livre/original.epub` reste intacte.

## Réglages de vitesse

```text
[translate_epub.md](translate_epub.md) "livre.epub" French --profile fast --workers 10 --max-retries 2
```

- `--profile fast` utilise des lots de 6 000 tokens, des réparations de 1 200 tokens, dix workers et un raisonnement faible ;
- `--profile standard` utilise des lots de 6 000 tokens, des réparations de 1 000 tokens, huit workers et un raisonnement faible ;
- `--profile editorial` utilise des lots de 3 500 tokens, des réparations de 800 tokens, quatre workers et un raisonnement moyen ;
- `--workers` contrôle le nombre maximal de traductions simultanées ;
- `--batch-tokens`, `--repair-tokens` et `--reasoning-effort` permettent de remplacer les valeurs du profil ;
- `--editorial-reasoning-effort` règle uniquement la relecture des métadonnées (moyen par défaut) ;
- `--cover-image` installe une couverture localisée pendant la passe éditoriale ;
- `--glossary` utilise un glossaire Markdown UTF-8 propre au livre ou au domaine ;
- `--keep-source` conserve le fichier EPUB d’entrée hors de `books/` après la préparation ;
- `--max-retries` relance uniquement les segments invalides sous forme de micro-lots.
- `--worker-timeout` limite chaque lot Codex à 1 800 secondes par défaut ; un dépassement est traité comme un lot à réparer ;
- `--editorial-timeout` limite la relecture éditoriale à 600 secondes par défaut.

## Fichiers de suivi

Le dossier `translation jobs fr` contient notamment :

```text
project.json
segments.jsonl
translations.jsonl
translation_run.json
translation_manifest.jsonl
translation_progress.md
batches/
prompts/
reports/
logs/
editorial/editorial_context.json
editorial/metadata_decision.json
editorial/cover_prompt.md
editorial/editorial_report.json
validation.json
final_report.json
```

`translation_run.json` détaille le temps mural, le temps cumulé des workers, les lots initiaux, les micro-lots de réparation, les segments récupérés dans des réponses partiellement invalides et les échecs restants.

La navigation EPUB, le NCX et les références de titres sont générés à partir des titres traduits validés plutôt que retraduits séparément. Cette table canonique évite les variations terminologiques entre chapitres et table des matières.
