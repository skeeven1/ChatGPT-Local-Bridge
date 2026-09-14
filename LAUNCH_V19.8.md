# Lancement de ChatGPT Local Bridge V19.8

## Prérequis

- Windows 10 ou 11
- Node.js 20 ou plus récent
- GitHub CLI déjà authentifié pour le transport historique du bridge
- Microsoft Paint pour les actions Paint

Le bridge n'a aucune dépendance npm externe.

## Vérifier l'archive

Dans PowerShell, depuis le dossier extrait :

```powershell
npm test
```

Le test runtime doit afficher :

```text
Agent Runtime loaded 19.8.0
Version compatible
Bridge ready
```

## Démarrer GPT Actions

Double-cliquer sur `START-GPT-ACTIONS.cmd`, ou lancer :

```powershell
node .\launch-gpt-actions.mjs
```

Attendre `PUBLIC PREFLIGHT: PASS` et `Bridge ready`, puis utiliser les URLs OpenAPI et Instructions affichées. La capacité aléatoire reste stockée localement dans `%LOCALAPPDATA%\ChatGPTLocalBridgeV19`.

## Démarrage automatique

Exécuter `INSTALL-AUTOSTART.cmd`. `UNINSTALL-AUTOSTART.cmd` retire uniquement l'entrée de démarrage; les données et watches locales sont conservées.

## Diagnostic

- `npm run test:runtime` vérifie le chargeur et le verrou de version.
- `npm run test:v19.8` vérifie le serveur HTTP, OpenAPI, le helper Windows, la perception, Paint, le validator et le recovery.
- Les actions HTTP sont journalisées dans `audit-actions.jsonl` et les commandes du transport historique dans `audit.jsonl`, sous le répertoire de données local.
