#!/bin/sh
# Installs the permission rule that lets the browser use the IR tracker. Run once:  sudo ./linux/install-udev-rule.sh
set -e
if [ "$(id -u)" -ne 0 ]; then echo "Run this with sudo:  sudo $0"; exit 1; fi
here=$(cd "$(dirname "$0")" && pwd)
cp "$here/99-ir-tracker.rules" /etc/udev/rules.d/99-ir-tracker.rules
udevadm control --reload-rules
udevadm trigger --subsystem-match=usb
echo "Done. Unplug the tracker and plug it back in, then press Connect in the app."
