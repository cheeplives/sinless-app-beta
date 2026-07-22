#!/bin/sh
# deploy.sh — pull the latest and syntax-check the PHP. Run on the server from
# inside the deployed directory:  ./deploy.sh
#
# config.php is gitignored, so it is never touched by the pull.
set -e
cd "$(dirname "$0")"

echo "==> git pull"
git pull --ff-only

echo "==> php -l (syntax check every endpoint)"
find api -name '*.php' -print -exec php -l {} \;

echo "==> done"
echo "    If you changed app JS/CSS and want OFFLINE clients force-refreshed,"
echo "    bump CACHE_VERSION in sw.js. Online clients update automatically."
