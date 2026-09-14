# ChatGPT Local Bridge V19.9.28 candidate

V19.9.28 conserve le bridge HTTP et le renderer Paint V19, puis renforce la boucle d'agent vérifiable : perception Windows, UI Automation, fusion de preuves, action minimale, validation avant/après et recovery borné.

## Nouveautés
- `WindowContext` complet (HWND, bounds client/fenêtre, état, focus, moniteur, DPI)
- UI Automation avant le fallback vision
- refus d'agir sous le seuil de confiance
- modèle d'action distinguant commande, exécution, changement et objectif
- validator avant/après et Recovery Manager
- recalibrage si Paint est déplacé ou redimensionné
- raster couleur/gris réellement dessiné par la souris (pas collé)
- jobs asynchrones pour éviter les timeouts GPT Actions
- pause automatique lorsque l'utilisateur bouge physiquement la souris
- F8 pause/reprise, F9 stop
- overlay compact progression/contrôles
- profils fast/balanced/quality/ultra
- port local dynamique et preflight public hérités de V18.2.1

## Installation
1. Extraire le ZIP.
2. Exécuter `npm test`.
3. Lancer `START-GPT-ACTIONS.cmd`.
4. Attendre `PUBLIC PREFLIGHT: PASS` et `Bridge ready`.
5. Réimporter l'OpenAPI URL dans le GPT Bridge.
6. Remplacer ses Instructions par `GPT-INSTRUCTIONS.txt`, puis enregistrer.

Consulter `LAUNCH_V19.8.md` pour les prérequis et le diagnostic.

Pour un portrait réaliste : `dessine Satoru Gojo dans Paint en mode qualité`.
