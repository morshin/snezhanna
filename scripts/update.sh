#!/bin/bash
set -e
cd /opt/snezhanna
git pull
npm install --production --ignore-scripts
sudo systemctl restart snezhanna
