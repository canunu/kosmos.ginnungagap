#!/bin/zsh

# Copies the project definition to Kosmos. It does not bring anything up: that is
# either `docker compose up -d` on the host or, after login, atlas.
#
# The target directory must already exist. It is created once during Ginnungagap
# Setup.
#
# To avoid scp prompting for a password every time, typhon must have your ssh key
# authorized. See kosmos.bootstrap/README.md, "Using deployment script".

scp compose.yaml typhon@canunu.me:ginnungagap/
scp .env typhon@canunu.me:ginnungagap/
