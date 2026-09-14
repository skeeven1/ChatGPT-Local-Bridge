# ChatGPT Local Bridge V19 — capacités

## Contrôle PC
- état PC, fenêtres, processus, applications installées
- lancement d'applications GUI
- captures écran/région, détection du canevas Paint
- souris, clic, drag, scroll, clavier (actions structurées uniquement)

## Paint V19
- **raster-color** : rendu cheat-like en vraies scanlines souris, palette Paint classique, sans collage
- **raster-gray** : portrait/halftone monochrome rapide
- **vector** : tracés SVG ligne par ligne
- **exact** : collage bitmap explicite uniquement
- profils `fast`, `balanced`, `quality`, `ultra`
- jobs de dessin asynchrones (pas de timeout GPT pendant un dessin long)
- `status`, `pause`, `resume`, `stop`
- mouvement physique de l'utilisateur => pause automatique et libération immédiate de la souris
- F8 = pause/reprise ; F9 = arrêt
- overlay compact avec progression et contrôles

## Surveillance
- surveillance persistante des notifications Windows
- filtre expéditeur Teams + alarme locale
- règles restaurées au redémarrage du bridge

## Workspaces
- list/read/search/write/mkdir/copy/move/delete confinés aux racines autorisées
- tâches npm, test, typecheck, build/check
- Git status/diff/log/commit borné

## Sécurité
- pas de `cmd.exe` / PowerShell distant arbitraire
- pas de keylogger
- pas d'accès mots de passe
- confinement des chemins
- actions sensibles séparées des lectures
