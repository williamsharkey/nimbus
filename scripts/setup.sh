#!/bin/bash
set -e

BASE=~/Desktop/nimbus-land
mkdir -p "$BASE"

REPOS=("shiro" "foam" "windwalker" "spirit" "fluffycoreutils")
GITHUB_USER="williamsharkey"

for repo in "${REPOS[@]}"; do
  if [ ! -d "$BASE/$repo" ]; then
    echo "Cloning $repo..."
    git clone "https://github.com/$GITHUB_USER/$repo.git" "$BASE/$repo"
  else
    echo "$repo already exists, pulling latest..."
    git -C "$BASE/$repo" pull --ff-only 2>/dev/null || true
  fi
done

echo ""
echo "Installing nimbus dependencies..."
cd "$BASE/nimbus"
npm install

echo ""
echo "Building client..."
npx esbuild src/client/app.ts --bundle --outfile=src/client/app.js --format=esm --target=es2022

echo ""
echo "Done! Run: cd $BASE/nimbus && npm run dev"
