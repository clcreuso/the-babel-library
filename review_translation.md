# Revue d’apprentissage après une traduction EPUB

## Utilisation recommandée

Après une traduction terminée, envoyer ce message dans la même session Codex :

```text
[review_translation.md](review_translation.md)
```

Il s’agit d’une instruction adressée à Codex, pas d’une commande de terminal. Codex inspecte
l’exécution de traduction qui vient de se terminer dans la session, cherche les problèmes et les
occasions d’amélioration, puis formule des propositions simples, généralisables et suffisamment
étayées. Il ne modifie rien. Le livre, la langue cible et le dossier de travail sont repris
directement depuis le contexte de la session et les résultats du pipeline.

## Mission

Tu réalises la revue d’apprentissage d’une traduction EPUB terminée. Ton objectif n’est pas de
complexifier le pipeline ni de rechercher une perfection théorique. Tu dois déterminer, à partir
de cette exécution réelle, si une petite amélioration peut rendre les prochaines traductions plus
fiables, plus naturelles, plus rapides ou moins coûteuses.

Identifie automatiquement la traduction la plus récente traitée dans cette session. Réutilise le
chemin du livre, la langue cible, le dossier de travail et le fichier final déjà annoncés ou produits
par `translate_epub.md`. Ne demande pas à l’utilisateur de les répéter lorsque le contexte permet de
les déterminer sans ambiguïté. Si aucune traduction terminée n’existe dans la session, explique
brièvement que cette revue doit être lancée juste après `translate_epub.md`.

Le projet repose sur une séparation importante :

- l’IA prend les décisions éditoriales qui dépendent du livre ;
- le programme déterministe protège la structure, réinsère les traductions, valide et reconstruit ;
- le cœur reste générique, lisible et sans règle spéciale propre à un livre, un éditeur ou une langue.

Une revue réussie peut conclure qu’aucune modification n’est nécessaire.

## Principes non négociables

- Travaille strictement en lecture seule.
- Ne modifie aucun script, template, test, rapport, EPUB, fichier de travail ou réglage.
- Ne crée aucun fichier et n’exécute aucune commande qui transforme ou reconstruit un artefact.
- Pars des fichiers de suivi produits par l’exécution, pas d’impressions générales.
- Ne relance pas la traduction complète et n’appelle pas de nouveaux workers pour effectuer la revue.
- Ne considère jamais une hausse de complexité comme gratuite.
- N’ajoute aucune règle spéciale fondée sur un titre, un auteur, un éditeur, un nom de fichier ou un
  exemple isolé.
- Ne déplace pas dans le code une décision qui appartient normalement à l’IA éditoriale.
- Ne masque jamais un défaut du pipeline en corrigeant seulement l’EPUB final.
- Ne change pas les réglages par défaut à partir d’un seul livre sans preuve forte et généralisable.
- Ne copie pas de longs extraits du livre dans le rapport, les tests ou le dépôt.
- Ne crée pas de nouveau système de métriques, de configuration ou de cache si les artefacts
  existants suffisent.
- Préfère supprimer une cause de réparation plutôt qu’ajouter une nouvelle couche de réparation.

## Sources à examiner

Résous d’abord le dossier du livre à partir de la dernière exécution de `translate_epub.md` visible
dans la session, puis confirme-le avec `project.json` et `final_report.json`. Ne suppose pas que le
nom technique du dossier correspond exactement au titre affiché.

Lis en priorité, lorsqu’ils existent :

```text
translation jobs <langue>/
├── project.json
├── translation_run.json
├── translation_run_history.jsonl
├── translation_manifest.jsonl
├── segments.jsonl
├── translations.jsonl
├── validation.json
├── final_report.json
├── logs/
├── reports/
└── editorial/
    ├── editorial_context.json
    ├── metadata_decision.json
    ├── editorial_report.json
    └── editorial_failure.json
```

Consulte aussi `original.epub`, l’EPUB traduit, les dossiers `extracted original` et `working
<langue>` seulement lorsque cela permet de confirmer une anomalie précise. Les rapports font foi
pour les métriques ; les fichiers du livre servent à vérifier les cas concrets.

## Revue adaptative

Adapte la profondeur de la revue aux signaux observés. Une exécution propre demande une revue
courte. Des réparations, avertissements, délais dépassés ou incohérences demandent une inspection
ciblée plus approfondie.

### 1. Résultat final

Vérifie :

- que la traduction, l’application, l’édition, la validation et la reconstruction sont terminées ;
- que chaque segment attendu possède une traduction valide, en tenant compte de la déduplication ;
- que `validation.json` ne contient aucune erreur non résolue ;
- que l’archive finale est intègre, avec `mimetype` en premier et non compressé ;
- que la langue, le titre, la navigation, les métadonnées et la couverture sont cohérents ;
- qu’aucune ressource étrangère à la couverture sélectionnée n’a été modifiée.

### 2. Qualité de traduction

N’essaie pas de relire intégralement le livre. Construis un échantillon ciblé et traçable comprenant
en priorité :

- tous les segments encore invalides ou réparés plusieurs fois ;
- quelques segments récupérés depuis une réponse partiellement invalide ;
- les titres, la table des matières et les textes liminaires ;
- des segments longs, courts, riches en balisage, en code ou en marqueurs protégés ;
- des occurrences dédupliquées et réutilisées ;
- des passages signalés par les logs ou les rapports.

Contrôle sur cet échantillon :

- absence de texte naturel source manifestement laissé non traduit ;
- conservation du sens, des négations, nombres, unités, noms propres et termes techniques ;
- français naturel et terminologie cohérente avec le contexte ;
- préservation exacte des marqueurs, du code, des liens et du balisage ;
- cohérence entre titres de chapitre, navigation et métadonnées.

Un simple mot anglais n’est pas une preuve d’échec : il peut s’agir de code, d’une marque, d’une
interface, d’un nom propre ou d’un terme consacré.

### 3. Décisions éditoriales

Compare la décision éditoriale avec les sources réellement disponibles :

- séparation titre et sous-titre ;
- auteurs et contributeurs ;
- description et sujets ;
- texte de couverture ;
- page de titre et autres remplacements liminaires.

Signale les omissions certaines, mais n’invente pas de données absentes ou ambiguës. Une différence
entre la couverture et la page de titre doit être arbitrée par les sources, pas par une règle codée.

### 4. Vitesse, coût et robustesse

Relève au minimum :

- temps mural et temps cumulé des workers ;
- nombre de segments, segments uniques, déduplications et résultats issus de la mémoire ;
- lots initiaux, lots de réparation et tentatives ;
- sorties partielles récupérées, segments invalides, délais dépassés et blocages externes ;
- estimations de tokens source, prompt et réponse lorsqu’elles existent.

Cherche les causes mesurables, pas seulement les symptômes. Distingue :

- la taille normale du livre ;
- un comportement ponctuel du modèle ;
- un défaut reproductible du pipeline ;
- un réglage possiblement sous-optimal qui nécessite encore plusieurs observations.

## Barrière avant recommandation

Présente une proposition comme recommandation ferme uniquement si les cinq conditions suivantes
sont remplies :

1. le fait est observé dans les artefacts de cette exécution ;
2. la cause est comprise avec une confiance élevée ;
3. le changement profite à plusieurs livres ou corrige une violation d’invariant ;
4. le changement est petit, lisible et testable ;
5. le bénéfice attendu dépasse clairement le coût de complexité.

Si une condition manque, classe l’idée comme hypothèse à confirmer et non comme changement
recommandé.

Classe chaque décision dans une seule catégorie :

- `aucun changement` : comportement normal ou preuve insuffisante ;
- `template/documentation` : proposition de meilleure consigne sans nouvelle mécanique ;
- `test` : proposition de protection d’un invariant déjà attendu ;
- `script` : proposition de correction d’un défaut déterministe et reproductible ;
- `réglage à observer` : hypothèse de performance à comparer sur d’autres livres.

## Formulation des propositions

Ne mets en œuvre aucune proposition. N’édite aucun fichier, ne prépare aucun patch, ne lance aucun
test et ne reconstruis pas l’EPUB.

Pour chaque proposition :

- indique le fait observé et l’artefact qui le prouve ;
- explique la cause probable et le niveau de confiance ;
- désigne le plus petit emplacement faisant autorité qui pourrait être amélioré ;
- décris le changement minimal envisagé, sans l’appliquer ;
- estime le bénéfice, le coût de complexité et le risque ;
- précise comment le changement pourrait être validé s’il était accepté.

Limite-toi aux trois propositions les plus utiles. Regroupe les variantes d’une même idée et écarte
les optimisations théoriques sans preuve.

## Réponse

Retourne directement dans la conversation un rapport court, factuel et autonome avec cette
structure :

```markdown
# Revue d’exécution

## Verdict
État du livre, niveau de confiance et décision principale.

## Chiffres clés
Mesures utiles de qualité, temps, coût et réparations.

## Constats
Faits observés, avec le nom des artefacts qui les prouvent.

## Propositions
Pour chaque proposition : priorité, catégorie, preuve, changement minimal envisagé, bénéfice,
complexité, risque et validation future.

## Éléments consultés
Artefacts et contrôles en lecture seule utilisés pour établir le diagnostic.

## Hypothèses à confirmer
Signaux intéressants qui ne justifient pas encore une modification.
```

Ne transforme pas le rapport en journal exhaustif. Donne les valeurs utiles, les causes confirmées,
les décisions prises et les hypothèses encore ouvertes.

## Restitution à l’utilisateur

Commence par le verdict. Indique ensuite :

- si l’EPUB final reste valide ;
- les propositions classées par priorité ;
- les preuves consultées ;
- au maximum trois hypothèses méritant une observation future.

Termine en rappelant explicitement qu’aucune modification n’a été effectuée. Ne présente pas une
absence de proposition comme un échec : préserver un cœur simple face à une preuve insuffisante est
une décision d’ingénierie valide.
