# Traduire rapidement un EPUB

## Utilisation recommandée

L’EPUB peut se trouver n’importe où sur la machine. Envoyer ensuite ce message dans Codex :

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

L’EPUB d’entrée peut se trouver n’importe où, y compris hors du dépôt ou directement dans `books/`. Le projet est toujours créé dans le dossier `books/` de ce dépôt, sans jamais produire un dossier `books/books/`. Une copie canonique nommée `original.epub` est rangée dans le dossier du livre et n’est jamais remplacée. Le fichier d’entrée original n’est jamais déplacé ni supprimé.

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
- analyse IA bornée des styles et de leur usage dans les gabarits XHTML ;
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

Dans Codex, ouvrir la couverture source, effectuer une traduction visuelle avec ce prompt, puis
comparer l’image obtenue côte à côte avec la source avant de l’installer. Le titre, le sous-titre,
l’auteur et le contributeur explicitement fournis peuvent changer ; toute autre zone textuelle
(citation, prix, série, ancien titre, marque éditoriale) doit rester présente, mot pour mot, au même
endroit et avec le même rôle visuel. Refaire une seule passe ciblée si une zone disparaît, devient
bilingue ou change sans instruction. Installer ensuite l’image sans recalculer la décision :

```sh
python3 epub_translate.py "livre.epub" French \
  --stage editorial --resume \
  --cover-image "cover-fr.jpg"
```

Si l’appel éditorial automatique est indisponible, une décision produite par l’agent superviseur ou
relue par un humain peut être injectée explicitement sans contourner la validation :

```sh
python3 epub_translate.py "livre.epub" French \
  --stage editorial \
  --editorial-decision "metadata-decision.json"
```

Seule la ressource de couverture sélectionnée à partir de l’OPF peut être remplacée. La déclaration
est normalisée lorsqu’elle est mal formée, sans choisir une autre illustration. Toutes les autres
images restent strictement préservées. Cette étape met aussi à jour la page de titre, le titre NCX,
`calibre:title_sort` et `calibre:subtitle`. Elle préserve l’ISBN, les identifiants et les noms propres
qui ne sont pas remis en cause par les sources du livre.

### 5. Compatibilité des styles

```sh
python3 epub_translate.py "livre.epub" French --stage style
```

Cette mission Codex distincte reçoit un inventaire compact des CSS et de leur usage réel dans les
gabarits XHTML. Elle recherche uniquement les contraintes qui peuvent masquer du contenu, bloquer
la pagination, empêcher la redistribution, déformer les images, contrarier les modes nuit/sépia ou
dépendre de ressources web absentes de l’EPUB.

Le modèle ne peut pas produire de CSS libre : il choisit parmi des candidats déterministes et des
transformations explicitement autorisées. Chaque décision est validée, les hashes avant/après sont
enregistrés et toute modification ultérieure non approuvée bloque la validation. Les couleurs de
texte et de fond imposées à la racine d’une même feuille forment un seul candidat indissociable,
même lorsqu’elles utilisent des sélecteurs distincts comme `html` et `body`. L’application des CSS,
du manifeste et du rapport est transactionnelle : une interruption restaure l’état précédent à la
reprise.

La décision et le rapport se trouvent dans `translation jobs fr/style/`. Une décision relue peut
être injectée sans contourner les mêmes contrôles :

```sh
python3 epub_translate.py "livre.epub" French \
  --stage style --style-decision "style-decision.json"
```

### 6. Validation

```sh
python3 epub_translate.py "livre.epub" French --stage validate
```

Une seule passe compare les structures, attributs, blocs protégés, ressources, métadonnées et documents du spine. La reconstruction est bloquée si une erreur est détectée.

### 7. Reconstruction

```sh
python3 epub_translate.py "livre.epub" French --stage build
```

Le fichier `mimetype` est ajouté en premier sans compression, puis toutes les autres ressources sont compressées. L’intégrité ZIP et l’ordre des membres sont contrôlés avant le remplacement atomique du résultat final.

## Reprendre une traduction

```text
[translate_epub.md](translate_epub.md) "books/Livre/original.epub" French --resume
```

Les traductions déjà présentes dans `translations.jsonl` ne sont pas recalculées. Les segments identiques d’un même livre sont dédupliqués, et la mémoire partagée `books/.translation-memory/fr.json` réutilise ceux rencontrés dans les autres livres tout en tenant compte de la version du glossaire.

Chaque invocation est aussi ajoutée à `translation_run_history.jsonl`. Le résumé
`translation_run.json` cumule les lots, le temps et les estimations de tokens : une reprise qui ne
fait presque rien n’efface donc plus l’histoire de la traduction. Si une limite d’usage ou un
problème d’authentification est reconnu avec certitude, le pipeline conserve le travail valide,
s’arrête sans gaspiller les tentatives de réparation et indique qu’une reprise ultérieure est possible.
L’entrée d’historique est créée dès le démarrage puis finalisée sur place. Une interruption conserve
ainsi un état `interrupted`, arrête uniquement les processus Codex appartenant à cette exécution et
laisse les traductions déjà validées disponibles pour `--resume`.
Si une ligne de l’historique a été corrompue par une édition externe, les lignes valides sont
récupérées et le JSONL original est conservé dans une sauvegarde horodatée `.corrupt-*`.

Un seul processus pilote un dossier de livre à la fois. Le parallélisme est déjà interne à une
exécution ; lancer deux étapes `translate` indépendantes sur le même dossier n’est pas pris en charge.

Après une réparation humaine ou supervisée, `apply` peut compléter automatiquement les occurrences
strictement identiques à partir des traductions déjà approuvées. Il ne généralise jamais une
traduction à un segment seulement « ressemblant ».

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
- `--style-reasoning-effort` règle uniquement l’analyse de compatibilité CSS (moyen par défaut) ;
- `--cover-image` installe une couverture localisée pendant la passe éditoriale ;
- `--editorial-decision` importe une décision éditoriale JSON validée par le même schéma, utile
  lorsqu’un humain ou l’agent superviseur doit reprendre la main sans figer cette décision dans le code ;
- `--style-decision` importe une décision de style bornée et validée ;
- `--glossary` utilise un glossaire Markdown UTF-8 propre au livre ou au domaine ;
- `--keep-source` reste accepté pour compatibilité, mais n’a plus d’effet : le fichier EPUB d’entrée est toujours conservé ;
- `--max-retries` relance uniquement les segments invalides sous forme de micro-lots.
- `--worker-timeout` limite chaque lot Codex à 1 800 secondes par défaut ; un dépassement est traité comme un lot à réparer ;
- `--editorial-timeout` limite la relecture éditoriale à 600 secondes par défaut.
- `--style-timeout` limite l’analyse stylistique à 600 secondes par défaut.

## Fichiers de suivi

Le dossier `translation jobs fr` contient notamment :

```text
project.json
segments.jsonl
translations.jsonl
translation_run.json
translation_run_history.jsonl
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
editorial/editorial_failure.json  # présent seulement après un échec
style/style_context.json
style/style_decision.json
style/style_report.json
style/style_failure.json           # présent seulement après un échec
validation.json
final_report.json
```

`translation_run.json` détaille le temps mural, le temps cumulé des workers, les lots initiaux, les micro-lots de réparation, les segments récupérés dans des réponses partiellement invalides et les échecs restants.

`translation_run_history.jsonl` constitue la mémoire chronologique des reprises. En cas d’échec
éditorial externe, `editorial/editorial_failure.json` conserve la cause et une piste de reprise.
`editorial/metadata_decision.json` reste la mémoire éditoriale faisant autorité ; elle peut être
réutilisée avec `--resume` ou fournie explicitement avec `--editorial-decision`.

`style/style_context.json` contient l’inventaire des conflits possibles et l’usage des classes dans
les gabarits. `style/style_decision.json` conserve la décision IA bornée ; `style/style_report.json`
enregistre les corrections appliquées et les hashes approuvés.

La déclaration de couverture est normalisée vers l’identifiant réel du manifeste EPUB 2 et, pour
EPUB 3, la propriété `cover-image` est ajoutée si nécessaire. Le prompt de couverture mentionne les
dimensions source. Une différence de dimensions ou de ratio est signalée pour relecture, mais ne
bloque pas automatiquement une décision visuelle pertinente.

La navigation EPUB, le NCX et les références de titres sont générés à partir des titres traduits
validés plutôt que retraduits séparément. Le synchroniseur sait recomposer les libellés formés de
plusieurs titres successifs, d’un titre de livre en préfixe ou suffixe, ou d’un titre dont le numéro
de section est omis dans le sommaire. Les libellés propres au livre proviennent des remplacements
approuvés par la passe éditoriale IA ; ils ne sont pas figés dans le code. Les titres XHTML qui ne
peuvent pas être déduits de cette structure restent des segments confiés à l’IA. Cette séparation
évite les variations terminologiques sans introduire de règle propre à un livre.
