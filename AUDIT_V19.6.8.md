# Audit V19.6.8 avant modification

Date de l'audit : 2026-09-14  
Source unique : `chatgpt-local-bridge-v19_6_8-runtime-loader-fix.zip` (71 204 octets)  
Portée : contenu extrait sans apport d'une version V15, V16 ou V18.

## État général

L'archive contient un bridge Windows fonctionnel et compact, mais elle n'est pas réellement cohérente en version 19.6.8. Le verrou et le bootstrap du Stable Core indiquent 19.6.8 tandis que le processus principal, le serveur HTTP, le lanceur, le schéma OpenAPI et les métadonnées de validation utilisent encore 19.6.6. Le correctif de chargement ESM Windows est bien présent dans le lanceur (`pathToFileURL(...).href`) et le module runtime se charge isolément, mais ce runtime n'est pas vérifié par le serveur HTTP avant qu'il annonce être prêt.

## Composants présents

- Pont principal `bridge/bridge.mjs` : 1 796 lignes, transport GitHub authentifié, télémétrie chiffrée, confinement des espaces de travail, actions fichiers/processus/applications/Git/UI/Paint, notifications persistantes et self-test.
- Serveur GPT Actions `bridge/actions-http-server.mjs` : HTTP local, capacité aléatoire dans l'URL, idempotence bornée, normalisation des erreurs d'action en HTTP 200, schéma OpenAPI 3.1.0.
- Lanceur `launch-gpt-actions.mjs` : chargement du Stable Core, serveur local sur port dynamique, tunnel Cloudflare, preflight public et fichier de connexion.
- Runtime `bridge/agent-runtime/` : Stable Agent Core, perception adaptative minimale et readiness minimale.
- Helpers Windows : `ui-helper.ps1` (capture, souris, clavier, focus, région claire, comparaison d'image) et `paint-raster-helper.ps1` (rendu raster asynchrone, pause/reprise/arrêt).
- Persistance locale : `config.json`, clé du bridge, verrou d'instance, `notification-watches.json`, statuts/contrôles des jobs Paint, cibles images et journaux JSONL.
- Recovery existant : relance à la demande du helper UI mort, reprise des watches au démarrage, retry des accès GitHub, rejet des commandes périmées et arrêt coordonné du serveur/tunnel.
- Sécurité existante : chemins confinés avec contrôle des liens symboliques, taille des entrées bornée, liste d'exécutables/scripts bloqués, SVG actif/externe rejeté, confirmation Windows pour les actions sensibles, pas de shell distant arbitraire.
- Routes compatibles GPT Actions : 14 macros et 49 sous-actions (`pc`, `app`, `screen`, `paint`, `ui`, `watch/read`, `watch`, `workspace/read`, `workspace/write`, `workspace/run`, `git/read`, `git`, `process`, `image`).
- Démarrage automatique Windows : scripts d'installation et désinstallation dans le dossier Startup.

## Composants manquants

- Aucun `package.json`, donc aucun `npm run test:runtime` ni orchestration officielle des tests.
- Aucun dossier `tests/` et aucun test V19.8.
- Pas de vraie `WindowContext` : la liste de fenêtres ne fournit que PID, nom, HWND et titre. Bounds client/fenêtre, visibilité, état réduit/maximisé, focus, moniteur et DPI manquent.
- Pas de couche Windows UI Automation/accessibilité pour détecter les éléments.
- Pas de fusion Windows/UI Automation/vision ni seuil central de confiance.
- Pas de modèle de cycle d'action commun distinguant commande envoyée, exécution, changement observé et objectif atteint.
- Pas de validator avant/après structuré.
- Pas de recovery manager couvrant focus perdu, déplacement, fermeture, timeout et coordonnées invalides.
- Pas de watchdog de relance : le lanceur observe la sortie du serveur ou du tunnel, puis arrête l'autre processus. Le script Startup relance seulement à l'ouverture de session.

## Bugs et écarts prouvés

1. **Versions divergentes.** `bridge-version.mjs`, `core-version-lock.json` et `runtime-bootstrap.mjs` déclarent 19.6.8, mais `bridge.mjs`, `actions-http-server.mjs` via son import, `launch-gpt-actions.mjs`, `runtime-version.json` et `VALIDATION.json` déclarent ou exposent 19.6.6.
2. **Ready prématuré.** Le serveur HTTP n'importe pas le bootstrap du Stable Core et ne compare pas la version chargée au verrou avant `server.listen`. Il peut donc annoncer `readyz` avec un runtime désynchronisé.
3. **Erreur runtime masquée.** Le lanceur journalise l'échec de chargement du runtime puis continue. Une absence ou une incompatibilité du runtime n'empêche pas le bridge d'être déclaré prêt.
4. **Détection Paint non spécifique.** `findPaintCanvasAction` appelle `find-bright-region` sans HWND Paint. Le helper inspecte seulement la fenêtre au premier plan et choisit la plus grande composante presque blanche. Une autre fenêtre blanche, une toile déjà dessinée ou une interface claire peut produire un faux résultat.
5. **Confiance trompeuse.** La confiance de la région claire vaut `pixels clairs connexes / grille entière`. Elle mesure la surface blanche, pas la probabilité que la région soit la toile Paint. Une grande toile déjà dessinée réduit mécaniquement ce score.
6. **Focus non validé.** `ensurePaintForeground` appelle `SetForegroundWindow`, mais ne refuse pas la suite lorsque `focused` vaut faux.
7. **Succès d'action non validé.** Plusieurs actions GUI renvoient `status: ok` dès que l'injection souris/clavier ou le collage a été demandé. Les modes vector et raster ne comparent pas systématiquement un état avant/après à l'objectif.
8. **Coordonnées de job figées.** Un job raster enregistre les bounds du canvas une fois. `paint-raster-helper.ps1` recalcule la fenêtre Paint, mais continue d'utiliser les coordonnées canvas initiales si la fenêtre est déplacée pendant le travail.
9. **Métadonnées anciennes.** Les titres du lanceur/README restent V19.0, le protocole et plusieurs chemins de télémétrie gardent le suffixe v15, et `diagnostic-report.mjs` annonce V19.5.1. Le protocole historique doit rester compatible, mais les métadonnées produit doivent être synchronisées.
10. **Self-test non portable au bac à sable.** `node bridge/bridge.mjs --self-test` valide toutes les parties exécutables sauf le test Git, qui échoue ici parce que l'environnement interdit au processus Node de lancer `git.exe` (`spawn EPERM`). Ce point n'est pas attribué au code sans exécution Windows hors bac à sable.

## Points validés

- Les trois fichiers JavaScript principaux passent `node --check` sous Node v24.14.1.
- Le chargement isolé du runtime retourne bien `version: 19.6.8`, `coreLoaded: true` et `apiContract: stable-v1`.
- Le chemin ESM Windows utilise `pathToFileURL(agentRuntimePath).href`; aucun import dynamique direct d'un chemin `C:\\...` n'a été trouvé.
- Le serveur HTTP démarre sur un port dynamique et répond réellement à `/readyz`, au schéma OpenAPI et à `pcInspect.status`.
- Le schéma retourné est OpenAPI 3.1.0 et contient les 14 routes macros attendues.
- Les appels HTTP testés retournent actuellement 19.6.6 de manière cohérente entre `/readyz`, OpenAPI et diagnostics, ce qui confirme précisément l'écart avec le verrou 19.6.8.
- Les dépendances JavaScript sont uniquement des modules Node intégrés; aucune installation tierce n'est requise.

## Risques

- Risque élevé de faux clic ou dessin hors toile lorsque la fenêtre active n'est pas Paint ou lorsque la toile n'est pas majoritairement blanche.
- Risque élevé de faux succès puisque l'exécution d'une commande est souvent assimilée à son résultat.
- Risque moyen de démarrage incohérent à cause des versions multiples et du runtime optionnel.
- Risque moyen d'interruption durable : serveur ou tunnel arrêté implique un arrêt complet sans relance bornée.
- Risque moyen de régression Windows si les futures couches ne gardent pas les routes et les contrôles de sécurité actuels.

## Plus gros goulot mesurable

Le plus gros goulot fonctionnel est la perception Paint. La seule primitive utilisée en production échantillonne une grille allant jusqu'à environ 360 points sur le plus grand axe, exécute un `GetPixel` par cellule puis une recherche de composantes, mais ne collecte **aucune** preuve UI Automation et ne lie pas la capture à un HWND Paint explicite. Le pipeline de décision dispose donc d'une source visuelle unique et d'un seul score de surface. Le nombre de sources indépendantes fiables est actuellement `1/3` (vision seulement; fenêtre et UI Automation non fusionnées), ce qui empêche de valider de façon robuste les scénarios déplacé, réduit, zoom différent et toile déjà dessinée.

## Décision d'audit

Conserver le pont HTTP, les routes, la persistance, les watches, les protections d'exécution et de fichiers, le verrou de version et les helpers existants. Corriger d'abord l'autorité de version et le gate de démarrage. Ajouter ensuite les couches V19.8 autour des primitives existantes, puis remplacer la détection Paint en production par une fusion HWND + bounds client + UI Automation + confirmation visuelle avec refus sous le seuil de confiance.
