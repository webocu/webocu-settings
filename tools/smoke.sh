#!/bin/sh
# UI smoke test in headless Chromium: rendering, focus, no JS errors.
# Run: make smoke  (needs the `serve` service up)
set -e

BASE=${BASE:-http://serve:8080/index.html}
ERR=/tmp/chrome.err
fail=0

# How much virtual time the page is given before the DOM is read. Headless runs
# it as fast as it can, so every timer inside the budget has already fired by the
# time anything is checked: four seconds is enough for everything the app does at
# startup, and a check that has to catch something a timer takes away again (the
# scrollbar, which goes three seconds after the last movement) lowers it and puts
# it back.
BUDGET=4000

run() { # run <query-string> -> page DOM in $DOM
  DOM=$(chromium-browser --no-sandbox --headless --disable-gpu \
        --enable-logging=stderr --v=0 --virtual-time-budget=$BUDGET \
        --dump-dom "$BASE?$1" 2>"$ERR")
}

check() { # check <pattern> <description>
  if printf '%s' "$DOM" | grep -q "$1"; then
    echo "  ok   $2"
  else
    echo "  FAIL $2  (missing: $1)"
    fail=1
  fi
}

count() { # count <pattern> <expected> <description>: the pattern occurs exactly <expected> times
  found=$(printf '%s' "$DOM" | grep -o "$1" | wc -l | tr -d ' ')
  if [ "$found" -eq "$2" ]; then
    echo "  ok   $3"
  else
    echo "  FAIL $3  (expected $2 of: $1, got $found)"
    fail=1
  fi
}

absent() { # absent <pattern> <description>
  if printf '%s' "$DOM" | grep -q "$1"; then
    echo "  FAIL $2  (unexpected: $1)"
    fail=1
  else
    echo "  ok   $2"
  fi
}

console_clean() {
  if grep -qiE 'uncaught|referenceerror|syntaxerror|typeerror' "$ERR"; then
    echo "  FAIL JS errors in console:"
    grep -iE 'uncaught|referenceerror|syntaxerror|typeerror' "$ERR" | head -5
    fail=1
  else
    echo "  ok   console has no JS errors"
  fi
}

echo "== panel opens on launch =="
run ''
check 'menu is-open' 'panel is open right away'
check 'rail__item is-active is-focused' 'focus starts on the rail'
check 'Screen' 'first section rendered'
console_clean

echo "== clock in the rail =="
run ''
check 'class="rail__clock"[^>]*>[0-9][0-9]:[0-9][0-9]<' 'time shown in 24h by default'
check 'class="rail__date"[^>]*>[A-Za-z]' 'date shown as weekday by default'
check 'class="rail__items"' 'the icons live in their own band under the clock'
console_clean

echo "== screen section =="
run 'section=screen'
check 'Energy saving' 'energy saving row'
check 'Turn screen off' 'screen off action'
check 'row row--select is-focused' 'focus moved into the rows'
console_clean

echo "== energy saving levels =="
# Blanking the panel is the separate action, not an energy saving level.
run 'section=screen&expand=energySaving'
check 'data-value="auto"' 'auto level'
check 'data-value="max"' 'maximum level'
absent 'data-value="screen_off"' 'no screen-off level in the list'
console_clean

echo "== the chevron means a submenu =="
# Screen holds a select and an action, Power two actions: neither leads anywhere,
# so a "›" there would promise a level that does not exist.
run 'section=screen'
absent 'row__chev' 'no chevron on select or action rows'
run 'section=power'
absent 'row__chev' 'no chevron on the power actions'
run 'section=sound'
check 'row--submenu[^>]*>.*row__chev' 'the submenu row keeps its chevron'
console_clean

echo "== sound section =="
run 'section=sound&expand=soundOutput'
check 'class="options"' 'option list expanded'
check 'TV speaker' 'TV output option'
check 'HDMI ARC' 'ARC output option'
check 'Bluetooth' 'Bluetooth output option'
console_clean

echo "== sound section: bluetooth entry =="
run 'section=sound'
check 'row row--submenu' 'submenu row rendered'
check 'Bluetooth devices' 'entry into the device list'
console_clean

echo "== bluetooth submenu =="
# No PalmServiceBridge in Chromium, so the mock devices from luna.js show up.
run 'section=bt'
check 'Bluetooth devices' 'submenu title'
check 'Refresh device list' 'refresh action'
check 'Soundbar (dev)' 'first mock device listed'
check 'Headphones (dev)' 'second mock device listed'
check 'row__value--on' 'connected device marked'
check 'Adapter' 'adapter info block'
console_clean

echo "== power section =="
run 'section=power'
check 'Restart TV' 'restart action'
check 'Turn TV off' 'power off action'
absent 'dialog is-open' 'confirmation dialog stays closed until OK'
console_clean

echo "== confirmation dialog =="
run 'confirm=restart'
check 'dialog is-open' 'dialog opens for a destructive action'
check 'Restart the TV now?' 'question text'
check 'dialog__btn is-focused' 'Cancel is focused by default'
absent 'dialog__btn--danger is-focused' 'Confirm is not focused'
console_clean

echo "== system section =="
run 'section=system'
check 'Operating system' 'OS group'
check 'Kernel' 'kernel row'
check 'Uptime' 'uptime row'
check 'class="info"' 'info blocks rendered'
check 'browser (dev)' 'platform detection falls back to browser'
check 'Serial number:</b> 000DEVBROWSER' 'serial number of the set, mocked in a browser'
# These rows were dropped from the block on purpose: the privileges of the helper
# service are reported where they can be changed, in App properties. Match the
# row markup so comments in index.html cannot masquerade as visible content.
absent 'SDK' 'no SDK row'
absent '<b>Locale:</b>' 'no locale row'
absent 'Privileges' 'no privileges row'
console_clean

echo "== system section: network block =="
# No connection manager in Chromium either, so the mock link from luna.js shows up.
run 'section=system'
check 'Network' 'network group'
check 'Wi-Fi:' 'wifi state row'
check 'Wi-Fi (dev)' 'the network name sits on the state row'
check '192\.168\.1\.42' 'address of the connected link'
check 'Ethernet:</b> not connected' 'the unplugged cable is reported as such'
check 'Wi-Fi MAC:</b> A0:11:22:33:44:55' 'hardware address, upper case'
check 'Ethernet MAC:</b> A0:11:22:33:44:66' 'ethernet hardware address'
check 'Bluetooth MAC:</b> A0:11:22:33:44:77' 'the bluetooth adapter address too'
console_clean

echo "== system section: storage block =="
# There is no df to run in Chromium, so the mock output from luna.js is parsed:
# what the block shows is the last five columns of the line about the partition.
run 'section=system'
check 'Storage' 'storage group'
check 'Partition:</b> /mnt/lg/appstore' 'the partition the apps are installed into'
check 'Size:</b> 3\.5G' 'the size as df printed it'
check 'Used:</b> 1\.2G [(]35%[)]' 'what is taken, with the percentage df worked out'
check 'Free:</b> 2\.2G' 'and what is left'
absent 'Filesystem' 'the header line of df is not a row'
console_clean

echo "== app properties section =="
# The list is the language, then levels: the clock and date, the theme, the background, what
# is general to the app and the panel as an object, and the rows that were there before.
run 'section=app'
check 'Language' 'language select'
check 'row row--submenu[^>]*data-id="appClock"' 'the clock and the date are a level right after the language'
check 'row row--submenu[^>]*data-id="appThemeLevel"' 'the theme is a level of its own'
check 'row row--submenu[^>]*data-id="appBackgroundLevel"' 'and so is the background'
check 'row row--submenu[^>]*data-id="appGeneral"' 'and what is general to the app'
check 'row row--submenu[^>]*data-id="appPanel"' 'and the panel as an object'
check 'row row--submenu[^>]*data-id="appToasts"' 'the notification rows sit one level down'
check 'row row--submenu[^>]*data-id="appWidgets"' 'the order of the rail is a level of its own'
check 'row row--submenu[^>]*data-id="aboutApp"' 'About leads to a level of its own'
check 'data-id="appClock"><span class="row__label">Clock and date</span><span class="row__value">[0-9][0-9]:[0-9][0-9] · [0-9][0-9]\.' 'the row reads the time and the date as they are now'
# None of the rows that moved down is a row of this list any more.
for id in appDarkMode appContrast appAccent appBg appBgRail appTransparency appWidth appSide appOpenAtStart appAutoClose appInsets appTimeFormat appDateFormat; do
  absent "data-id=\"$id\"" "no $id row in this list any more"
done
check 'Reset app settings' 'the reset action is the last row'
console_clean

echo "== the theme level =="
run 'section=theme'
check 'pane__title">Theme' 'the level has a title of its own'
check 'Dark mode' 'dark mode switch'
check 'Contrast theme' 'contrast switch'
check 'Accent colour' 'accent colour select'
check 'class="swatch"' 'the accent row shows the colour, not only its name'
check 'class="toggle is-on"' 'dark mode is on by default'
check 'data-theme="dark"' 'default mode applied to <html>'
check 'data-contrast="off"' 'contrast off by default'
console_clean

echo "== reset back to the defaults =="
# Destructive enough to ask first: it drops every choice the user made.
run 'confirm=appReset'
check 'dialog is-open' 'the reset asks before it wipes anything'
check 'Reset the settings of this app?' 'question text'
check 'dialog__btn is-focused' 'Cancel is focused by default'
console_clean

echo "== accent colours =="
run 'section=app&expand=appAccent'
check 'data-value="magenta"' 'magenta is in the list'
check 'data-value="azure"' 'azure is in the list'
check 'Orchid' 'colour names translated'
check 'class="option is-selected[^"]*" data-id="appAccent" data-value="magenta"' 'magenta selected by default'
swatches=$(printf '%s' "$DOM" | grep -o 'class="swatch"' | wc -l)
if [ "$swatches" -ge 29 ]; then
  echo "  ok   28 swatches in the list plus the one on the row ($swatches)"
else
  echo "  FAIL expected 29 swatches, counted $swatches"
  fail=1
fi
console_clean

echo "== accent preview =="
run 'section=app&accent=cyan'
check '\-\-accent: *#00d5ff' 'chosen colour written onto <html>'
console_clean

echo "== the clock level =="
run 'section=clock'
check 'pane__title">Clock' 'the two formats have a level of their own'
check 'row row--select[^>]*data-id="appTimeFormat"' 'time format row'
check 'row row--select[^>]*data-id="appDateFormat"' 'date format row'
check 'row row--select[^>]*data-id="appClockSize"' 'the size of the clock'
check 'row row--select[^>]*data-id="appDateSize"' 'and of the date'
console_clean

echo "== clock formats =="
# Every option is its own preview: the current moment rendered that way.
# ?expand= alone is enough: it opens whichever level the row lives on.
run 'expand=appTimeFormat'
check 'data-value="24h"[^>]*>.*[0-9][0-9]:[0-9][0-9]' '24h option previews itself'
check 'data-value="12h"[^>]*>.*[0-9]:[0-9][0-9] [AP]M' '12h option previews itself'
check 'data-value="24hn"' 'the 24-hour clock with no zero before a single digit'
# The empty choice is the first of the list, and it says so in a word.
check 'data-id="appTimeFormat" data-value="off"' 'the list has the empty choice'
check '>Empty<' 'and it reads Empty, not nothing'
run 'expand=appDateFormat'
check 'data-value="dmy"' 'day.month.year'
check 'data-value="mdy"' 'month/day/year'
check 'data-value="ymd"' 'year-month-day'
check 'data-value="dmon"[^>]*>.*[0-9] [A-Z][a-z][a-z]' 'day with the month name'
check 'data-value="dmonwd"[^>]*>.*[0-9] [A-Z][a-z][a-z], [A-Z][a-z][a-z]' 'the same plus the short weekday'
check 'data-value="wday"[^>]*>.*day<' 'the weekday spelled out on its own'
check 'data-value="dm"' 'day.month'
check 'data-value="wdaydm"' 'weekday, day and month'
check 'data-value="wdaynum"' 'weekday and day.month'
check 'data-value="dlong"' 'day and the full name of the month'
run 'expand=appClockSize'
count 'data-id="appClockSize" data-value=' 5 'five sizes of the clock: XS S M L XL'
console_clean

echo "== the new formats and the sizes in the rail =="
run 'time=24hn'
absent 'class="rail__clock"[^>]*>0[0-9]:' 'the 24-hour clock without a zero before a single digit'
run 'date=dm'
check 'class="rail__date"[^>]*>[0-9][0-9]\.[0-9][0-9]<' 'the date as day.month'
run 'date=dlong&lang=ru'
check 'class="rail__date"[^>]*>[0-9]* [а-я]*<' 'the full name of the month, in the genitive in Russian'
run ''
check 'data-clock-size="m"' 'the clock is the middle size by default'
check 'data-date-size="m"' 'and so is the date'
run 'clockSize=xl&dateSize=xs'
check 'data-clock-size="xl"' 'the clock can be the largest size'
check 'data-date-size="xs"' 'and the date the smallest, each on its own'
console_clean

echo "== the weekday formats in the rail =="
run 'date=dmonwd'
check 'class="rail__date"[^>]*>[0-9]* [A-Z][a-z][a-z], [A-Z][a-z][a-z]<' 'day, month and weekday on the date line'
run 'date=wday'
check 'class="rail__date"[^>]*>[A-Za-z]*day<' 'the long weekday alone, with no year next to it'
run 'date=wday&lang=ru'
check 'class="rail__date"[^>]*>[А-Яа-я]*<' 'and translated where the dictionary has it'
console_clean

echo "== either band can be switched off =="
# The empty option at the end of each list: the band is dropped through <html>,
# so the rail keeps its geometry and the CSS does the hiding.
run 'time=off'
check 'data-clock="off"' 'no time format, no clock band'
check 'data-date="on"' 'the date is untouched'
run 'date=off'
check 'data-date="off"' 'and the other way round'
run 'time=off&date=off'
check 'data-clock="off"' 'both at once'
check 'data-date="off"' 'both at once, the date too'
console_clean

echo "== how the two bands are drawn =="
run 'section=clock'
check 'data-clock-accent="on"' 'accent colour by default'
check 'data-date-accent="on"' 'on the date as well'
check 'data-clock-bold="on"' 'and bold type'
console_clean

echo "== the languages =="
# One row per dictionary, and the endonym is what each option is called.
run 'expand=appLanguage'
check 'data-value="de"[^>]*>.*Deutsch' 'German is offered under its own name'
check 'data-value="zh"[^>]*>.*简体中文' 'and so is Simplified Chinese'
run 'lang=pl'
check 'pane__title">Ekran' 'a Latin-script dictionary reaches the pane'
run 'lang=zh-CN'
check 'pane__title">屏幕' 'and a region suffix is cut off the code'
console_clean

echo "== a dropdown opens in place =="
# Six presses of down reach the auto-close list in General, far down the level:
# opening it must leave the level where it is scrolled and not put it back to the
# top (a full render did), so the offset stays non-zero.
run 'section=general&keys=down,enter'
check 'class="options" data-for="appAutoClose"' 'a dropdown in a level opens under its row'
check 'class="rows__scroll" style="transform: translateY(-[1-9]' 'and the level stays scrolled'
# A list taller than the window (the accents) puts its row at the top.
run 'section=theme&keys=down,down,enter'
check 'class="options" data-for="appAccent"' 'a long list opens too'
console_clean

echo "== transparency of the overlay =="
run 'section=bg'
check '\-\-ui-opacity: *1' 'solid by default: no transparency at all'
run 'section=bg&transparency=50'
check '\-\-ui-opacity: *0\.5' 'chosen value written onto <html> as what is left of it'
# Between the steps of five, and above the ceiling of seventy.
run 'section=bg&transparency=53'
check '\-\-ui-opacity: *0\.45' 'a value between two steps snaps to the nearer one'
run 'section=bg&transparency=100'
check '\-\-ui-opacity: *0\.3' 'anything over the ceiling lands on 70%'
run 'section=bg&transparency=0'
check '\-\-ui-opacity: *1' 'and zero is the smallest value'
console_clean

echo "== no numbers on the sliders =="
# The track is the readout: a slider row carries the label and nothing else.
run 'section=bg'
check 'row__label">Transparency</span></span><span class="slider"' 'the track follows the transparency label with no number between them'
run 'section=panel'
check 'row__label">Panel width</span></span><span class="slider"' 'and the same on the width row'
console_clean

echo "== the panel itself is three levels of its own =="
# The rows the section handed down: the two pictures behind the columns and how much of the
# video shows through are the background; how wide the panel is, which edge it stands on and
# how far off its ends are the panel; the start and the idle close are what is general.
run 'section=bg'
check 'pane__title">Background' 'the background has a title of its own'
check 'row row--slider[^>]*data-id="appBg"' 'the picture behind the rows'
check 'row row--slider[^>]*data-id="appBgRail"' 'the one behind the widgets, a row of its own'
check 'row row--slider[^>]*data-id="appTransparency"' 'how much of the video shows through'
run 'section=panel'
check 'pane__title">Panel' 'the panel has a title of its own'
check 'row row--slider[^>]*data-id="appWidth"' 'how wide it is'
check 'row row--select[^>]*data-id="appSide"' 'and which edge it comes out of'
check 'row row--submenu[^>]*data-id="appInsets"' 'and the insets, a level below this one again'
run 'section=general'
check 'pane__title">General' 'general has a title of its own'
check 'data-id="appOpenAtStart"' 'the Autostart row'
check 'data-id="appAutoClose"' 'and the idle close'
console_clean

echo "== how the panel comes onto the screen =="
# Seven entrances (App properties -> Panel -> Entrance effect): out from behind the edge the
# panel stands at by default, from the opposite edge, from the top or the bottom, faded,
# grown, or at once. The attribute is what the CSS reads; the panel is up with each of them.
run ''
check 'data-panel-effect="edge"' 'by default the panel comes out from behind its own edge'
for effect in opposite top bottom fade pop none; do
  run "panelEffect=$effect"
  check "data-panel-effect=\"$effect\"" "the $effect entrance can be previewed"
  check 'menu is-open' 'and the panel is up with it'
done
run 'panelEffect=left'
check 'data-panel-effect="edge"' 'a name that is no entrance leaves the default'
run 'section=panel'
check 'row row--select[^>]*data-id="appEffect"' 'the Panel level has the row'
run 'section=panel&expand=appEffect'
count 'data-id="appEffect" data-value=' 7 'seven entrances in the list'
console_clean

echo "== width of the panel ="
run 'section=panel'
check '\-\-panel-w: *576px' 'the default stop, 30% of 1920'
check 'data-width="full"' 'the full set of metrics there'
run 'section=panel&width=18'
check '\-\-panel-w: *346px' 'the narrowest stop is 18% of the screen'
# Under a third of the screen the pane keeps some 240px, so the metrics inside
# it go one size down (smaller rail, padding, labels and switches).
check 'data-width="narrow"' 'the tighter metrics come with the narrow stops'
run 'section=panel&width=27'
check 'data-width="narrow"' 'the fourth stop is narrow too'
run 'section=panel&width=30'
check '\-\-panel-w: *576px' 'and the fifth is where the full metrics start'
check 'data-width="full"' 'so it is not narrow'
run 'section=panel&width=75'
check '\-\-panel-w: *1440px' 'the widest stop is three quarters of the screen'
# Off the grid of twenty stops (18 + n * 3) and past both ends of it.
run 'section=panel&width=20'
check '\-\-panel-w: *403px' 'a value between two stops snaps to the nearer one (21%)'
run 'section=panel&width=90'
check '\-\-panel-w: *1440px' 'anything above three quarters is held there'
run 'section=panel&width=0'
check '\-\-panel-w: *346px' 'anything under the floor lands on 18%'
console_clean

echo "== each column can be painted from a picture =="
run 'section=bg'
check 'data-bg="off"' 'the palette paints the rows in a fresh install'
check 'data-bg-rail="off"' 'and the widgets as well'
check '\-\-bg-opacity: *0' 'so neither picture layer is drawn'
check '\-\-bg-opacity-rail: *0' 'the rail one no more than the other'
check 'row row--slider[^>]*data-id="appBg"' 'a slider says how solid the main picture is'
check 'row row--slider[^>]*data-id="appBgRail"' 'and a second one the widgets picture'
run 'section=app&bg=100'
check 'data-bg="on"' 'turned on by the debug param'
check '\-\-bg-opacity: *1' 'as solid as the picture goes'
# One column at a time: the parameter of the other is not touched, which is what
# the two sliders are for.
absent 'data-bg-rail="on"' 'the widgets are left to the palette'
run 'section=app&bgRail=100'
check 'data-bg-rail="on"' 'the widgets have a parameter of their own'
check '\-\-bg-opacity-rail: *1' 'and a variable of their own'
absent 'data-bg="on"' 'with the rows left to the palette this time'
run 'section=app&bg=40&bgRail=70'
check '\-\-bg-opacity: *0\.4' 'any step of ten in between'
check '\-\-bg-opacity-rail: *0\.7' 'each column at its own step'
# Which of the four files each column takes is the stylesheet's business, and the
# theme is what picks it: one attribute here, four paths there.
run 'section=app&bg=100&bgRail=100&theme=light'
check 'data-bg="on"' 'still on with the light palette'
check 'data-bg-rail="on"' 'both columns are'
check 'data-theme="light"' 'and the theme is what tells the two apart'
# Off the grid of ten and past both ends of it. The bottom of the range is the off
# state of the setting, so a value under it turns the layer off altogether.
run 'section=app&bg=44'
check '\-\-bg-opacity: *0\.4' 'a value between two steps snaps to the nearer one'
run 'section=app&bg=180'
check '\-\-bg-opacity: *1' 'anything above a hundred per cent is held there'
run 'section=app&bg=0'
check 'data-bg="off"' 'nothing at the bottom of the range: the palette again'
run 'section=app&bg=-20'
check 'data-bg="off"' 'and below it as well'
# Stored rather than previewed: the main picture is the first row of Background, OK
# picks it up and four steps of ten make it four tenths solid.
run 'section=bg&keys=enter,right,right,right,right'
check 'row row--slider is-focused is-editing" data-id="appBg"' 'the row is held like any other slider'
check '\-\-bg-opacity: *0\.4' 'and the arrows reach the value'
check 'data-bg="on"' 'the layer comes on as soon as the value leaves zero'
absent 'data-bg-rail="on"' 'and the widgets stay as they were'
# The row under it, the same way: one ▼ before OK.
run 'section=bg&keys=down,enter,right,right'
check 'row row--slider is-focused is-editing" data-id="appBgRail"' 'the widgets picture is the second row'
check '\-\-bg-opacity-rail: *0\.2' 'and its own value is what the arrows move'
console_clean

echo "== the insets of the panel =="
run 'section=insets'
check 'pane__title">Panel insets' 'the level has a title of its own'
check 'row row--slider[^>]*data-id="appPadTop"' 'a slider for the top inset'
check 'row row--slider[^>]*data-id="appPadBottom"' 'and one for the bottom'
# Three levels deep — the section, Panel, the insets — and ◀ walks back down one
# at a time, standing each time on the row that opened the level being left.
run 'section=insets&keys=left'
check 'pane__title">Panel' 'one step back is the level that opened it'
check 'row row--submenu is-focused" data-id="appInsets"' 'on the row that led in'
run 'section=insets&keys=left,left'
check 'pane__title">Settings widget' 'the second step back is the section itself'
check 'row row--submenu is-focused" data-id="appPanel"' 'on the row that led into Panel'
run 'section=insets&keys=left,left,left'
check 'rail__item--bottom is-active is-focused' 'and the third leaves the rows for the rail'
run ''
check '\-\-pad-top: *0px' 'nothing is inset by default'
check '\-\-pad-bottom: *0px' 'at either end'
check 'data-rail="full"' 'and the rail keeps its clock, date and labels'
run 'padTop=120&padBottom=200'
check '\-\-pad-top: *120px' 'the top inset is applied in pixels'
check '\-\-pad-bottom: *200px' 'and so is the bottom one'
# Off the grid of two and past both ends of it.
run 'padTop=131'
check '\-\-pad-top: *132px' 'a value between two steps snaps to the nearer one'
run 'padTop=900'
check '\-\-pad-top: *540px' 'anything above half the screen is held at half'
run 'padTop=-40'
check '\-\-pad-top: *0px' 'and below zero at zero'
# Both sliders reach half the screen, so together they could ask for a panel of
# nothing — and nothing on screen is nothing to put the setting back with.
run 'padTop=540&padBottom=540'
check '\-\-pad-top: *540px' 'the top inset is kept as asked'
check '\-\-pad-bottom: *140px' 'the bottom one gives way to the floor of 400px'
# What is left of a panel this short belongs to the icons: the section pinned to
# the foot of the rail is the way back into this very setting.
check 'data-rail="tight"' 'the rail drops its decoration instead of an icon'
check 'rail__item--bottom' 'the pinned section is still on it'
console_clean

echo "== a slider is picked up before it moves =="
# Two rows down from the top of Background is the transparency slider (the two background
# pictures first, then it).
run 'section=bg&keys=down,down'
check 'row row--slider is-focused" data-id="appTransparency"' 'focus stands on the transparency slider'
absent 'is-editing' 'standing on it does not pick it up'
# ◀ is also the way out of the level, so a slider that answered it on plain focus
# took that way out away from itself.
run 'section=bg&keys=down,down,left'
check '\-\-ui-opacity: *1' 'left does not touch the value there'
check 'row row--submenu is-focused" data-id="appBackgroundLevel"' 'it steps one level up, as on any other row'
run 'section=bg&keys=down,down,enter'
check 'row row--slider is-focused is-editing" data-id="appTransparency"' 'OK picks the slider up'
check 'pane__hint">◀ ▶ — value, OK — done' 'the footer says what the arrows do now'
run 'section=bg&keys=down,down,enter,right'
check '\-\-ui-opacity: *0\.95' 'held, it steps the value up: five per cent more of the video'
run 'section=bg&keys=down,down,enter,right,enter,left'
check '\-\-ui-opacity: *0\.95' 'the second OK puts it down: left is the way out again'
absent 'is-editing' 'and nothing is held any more'
console_clean

echo "== the list scrolls =="
# App properties is the longest level with rows on it: a dozen of them, more than
# the pane can hold at once.
run 'section=app'
check 'rows__scroll" style="transform: translateY(0px)' 'a level opens at its top'
absent 'rows__bar is-on' 'and carries no bar yet: being long is not a movement'
# The bar answers the movement and goes three seconds after the last one. Headless
# runs virtual time as fast as it can, so the budget is what decides which side of
# those three seconds the DOM is read on.
BUDGET=2000
run 'section=app&keys=down,down,down,down,down,down,down,down'
check 'rows__scroll" style="transform: translateY(-[0-9]' 'the focus takes the list with it'
check 'class="rows__bar is-on"' 'and a scroll that moved it brings the bar up'
check 'rows__thumb" style="height: [0-9]' 'the thumb says how much of the level is on screen'
BUDGET=4000
run 'section=app&keys=down,down,down,down,down,down,down,down'
check 'rows__scroll" style="transform: translateY(-[0-9]' 'the list stays where it was taken'
absent 'rows__bar is-on' 'while the bar goes three seconds after it stopped'
# Narrow, the read-only blocks of System wrap onto far more lines than the pane
# has: nothing there can be focused, so ▲ ▼ scroll instead of moving.
run 'section=system&width=18&keys=down,down'
check 'rows__scroll" style="transform: translateY(-[0-9]' '▲ ▼ scroll a level with nothing to focus'
run 'section=power'
check 'class="rows__bar"><span' 'a level that fits shows no bar at all'
console_clean

echo "== the order of the rail =="
run 'widgetsOff=&widgets=screen,eco,sound,bluetooth,power,system,tweaks,debug,app'
check 'rail__label">Screen.*rail__label">Eco.*rail__label">Sound.*rail__label">Bluetooth.*rail__label">Power.*rail__label">System.*rail__label">Tweaks.*rail__label">Debug.*rail__label">Settings' 'built-in order, the app section last'
run 'section=widgets'
check 'pane__title">Widgets' 'the level has a title of its own'
# The switch for the captions under the icons is the top row of the level, ahead
# of the movable ones — which is why every ?keys= below starts with a ▼.
check 'row row--toggle[^>]*data-id="appRailLabels"' 'the captions switch is the first row'
check 'row row--reorder[^>]*data-id="widget:screen"' 'one row per movable section'
check 'row row--reorder[^>]*data-id="widget:system"' 'the last movable one too'
check 'row__grab">↕' 'the arrows say the row itself moves'
# The way back into this list is a row of the pinned section, so it stays put
# and is only reported here.
absent 'data-id="widget:app"' 'the pinned section is not offered as a row'
check 'Settings widget:</b> cannot be changed' 'and is reported instead'
console_clean

echo "== moving a section =="
# ?keys= presses the remote: OK picks the first row up, ▼ moves it down a place.
run 'widgetsOff=&widgets=screen,eco,sound,bluetooth,power,system,tweaks,debug,app&section=widgets&keys=down,enter,down'
check 'data-id="widget:eco".*data-id="widget:screen"' 'the row swapped with the one below it'
check 'rail__label">Eco.*rail__label">Screen' 'and the rail followed'
check 'is-focused is-editing" data-id="widget:screen"' 'the row travels with the focus and stays held'
check 'pane__hint">▲ ▼ — move, ◀ ▶ — off / on, OK — drop' 'the footer says what both pairs of arrows do now'
# The rail is not written again for a step: its icons change places (each is found by the
# id of its section and told its new place in Settings.sections, which is what a click reads).
check 'data-id="eco" data-section="0"' 'the icon of Eco took the first place'
check 'data-id="screen" data-section="1"' 'and the one of Screen the second'
check 'rail__item rail__item--bottom" role="tab" data-id="app"' 'the pinned section is still the last icon'
run 'widgetsOff=&widgets=screen,eco,sound,bluetooth,power,system,tweaks,debug,app&section=widgets&keys=down,enter,down,up'
check 'data-id="widget:screen".*data-id="widget:eco"' 'a step down and a step up put the rows back'
check 'data-id="screen" data-section="0"' 'and the icons'
check 'is-focused is-editing" data-id="widget:screen"' 'the row is held through both steps'
run 'widgetsOff=&widgets=screen,eco,sound,bluetooth,power,system,tweaks,debug,app&section=widgets&keys=down,enter,down,down,enter'
check 'data-id="widget:eco".*data-id="widget:sound".*data-id="widget:screen"' 'two presses, two places'
absent 'is-editing' 'the second OK drops it'
# Nothing to swap with at the ends: the row stays where it is, and held.
run 'widgetsOff=&widgets=screen,eco,sound,bluetooth,power,system,tweaks,debug,app&section=widgets&keys=down,enter,up'
check 'data-id="widget:screen".*data-id="widget:eco"' 'the top row cannot go up'
check 'is-focused is-editing" data-id="widget:screen"' 'and is still held'
# Leaving the level keeps the order, and lands back on the row that opened it.
# OK first: held, the row answers ◀ itself (it switches its section off), the same
# way a held slider does — putting it down is what gives ◀ back to the level.
run 'widgetsOff=&widgets=screen,eco,sound,bluetooth,power,system,tweaks,debug,app&section=widgets&keys=down,enter,down,enter,left'
check 'pane__title">Settings widget' 'left goes back up one level'
check 'row row--submenu is-focused" data-id="appWidgets"' 'onto the row that opened it'
check 'rail__label">Screen.*rail__label">Eco.*rail__label">Sound' 'with the original widgets order visible on rail'
console_clean

echo "== the order can be previewed =="
run 'widgets=power,system'
check 'rail__label">Power.*rail__label">System.*rail__label">Screen.*rail__label">Sound' 'the listed sections come first, the rest keep their order'
check 'rail__label">Settings' 'the pinned section stays at the foot'
# A stored list is repaired rather than refused: unknown ids dropped, missing
# ones appended, the pinned one ignored wherever it is named.
run 'widgets=nope,,power,power,app'
check 'rail__label">Power.*rail__label">Screen.*rail__label">Sound.*rail__label">System.*rail__label">Settings' 'nonsense falls back to the built-in order'
console_clean

echo "== a section can be switched off =="
run 'section=widgets'
check 'data-id="widget:screen"><span class="row__label">Screen</span><span class="toggle is-on"' 'every section is on the rail to begin with'
# OK picks the row up, ◀ switches its section off: ▲ ▼ are taken by moving it,
# so the other pair is what the switch is left with.
run 'section=widgets&keys=down,enter,left'
check 'row row--reorder row--off is-focused is-editing" data-id="widget:screen"' 'the row is marked off, and is still held'
check 'data-id="widget:screen"><span class="row__label">Screen</span><span class="toggle">' 'the switch went with it'
absent 'rail__label">Screen' 'the rail dropped the icon'
check 'rail__label">Sound' 'and kept every other one'
check 'row row--reorder[^>]*data-id="widget:screen"' 'the row keeps its place in the list'
run 'section=widgets&keys=down,enter,left,right'
check 'rail__label">Screen' '▶ puts the section back'
check 'toggle is-on' 'and the switch with it'
# The way back into this level is a row of the pinned section, so the rail can
# never be emptied: ◀ on that row has nothing to switch and steps out instead.
absent 'data-id="widget:app"' 'the pinned section is still not offered as a row'
console_clean

echo "== the sections left off the rail can be previewed =="
run 'widgetsOff='
run 'widgetsOff=screen,sound'
absent 'rail__label">Screen' 'a listed section is not drawn'
absent 'rail__label">Sound' 'nor the second one'
check 'rail__label">Power' 'the rest stay where they were'
check 'rail__label">Settings' 'the pinned one is never switched off'
check 'pane__title">Power' 'and the first section left is the one that opens'
run 'widgetsOff=screen,sound&keys=down'
check 'pane__title">System' '▲ ▼ walk the icons that are there'
# An empty list is a preview of its own: it puts every section back.
run 'widgetsOff='
check 'rail__label">Screen' 'nothing switched off, whatever the store says'
console_clean

echo "== tweaks is off the rail until it is asked for =="
# The one section that ships switched off: it asks for root, which is not an
# errand to meet by walking the rail.
run ''
absent 'rail__label">Tweaks' 'a fresh install does not carry it'
run 'section=tweaks'
absent 'pane__title">Tweaks' 'and it cannot be opened while it is off'
check 'pane__title">Screen' 'the panel opens on the first section it has'
# The row that switches it is in the Widgets level, in its built-in place, marked
# off the same way any other switched-off section is.
run 'section=widgets'
check 'row row--reorder row--off[^>]*data-id="widget:tweaks"' 'the Widgets level offers it, switched off'
# ?widgetsOff= names nobody, so every section is on the rail whatever is stored.
run 'widgetsOff=1'
check 'rail__label">Tweaks' 'switched on, it takes an icon of its own'
console_clean

echo "== tweaks: the request for root =="
run 'widgetsOff=1&section=tweaks'
check 'pane__title">Tweaks' 'the section opens once it is on the rail'
check 'row row--action[^>]*data-id="requestPriv"' 'asking for privileges is its only action'
# What a browser can say about the helper service: there is none, and no root.
check '<b>Helper service:</b>' 'the block reports whether the service is up'
check '<b>Privileges:</b>' 'and what it may do'
run 'section=app'
absent 'data-id="requestPriv"' 'App properties no longer carries the request'
console_clean

echo "== where the notification appears =="
run 'section=toasts'
check 'Notifications' 'the level has a title of its own'
check 'At the top' 'the edge is a switch'
check 'Alignment' 'the side of it is a list'
check 'data-toast-v="top"' 'top edge by default'
check 'data-toast-h="center"' 'centred by default'
run 'toast=busy&toastAt=bottom-left'
check 'data-toast-v="bottom"' 'bottom edge applied via ?toastAt='
check 'data-toast-h="left"' 'alignment applied via ?toastAt='
check 'is-open' 'the balloon is still shown there'
run 'toastAt=top-right'
check 'data-toast-h="right"' 'right alignment applied'
# Nonsense leaves both halves where they were rather than half-applying.
run 'toastAt=sideways'
check 'data-toast-v="top"' 'an unknown edge is refused'
check 'data-toast-h="center"' 'and the alignment is left alone'
console_clean

echo "== the balloon follows the theme and the transparency =="
run 'section=toasts&expand=appToastAlign'
check 'data-value="center"' 'centre option in the list'
check 'Centre' 'option labels translated'
# The balloon lives inside .ui, so the one opacity of the layer covers it too.
run 'toast=busy&transparency=50'
check '\-\-ui-opacity: *0\.5' 'the layer with the balloon in it is faded'
console_clean

echo "== panel position =="
run ''
check 'data-side="right"' 'panel is docked to the right by default'
run 'side=left'
check 'data-side="left"' 'left docking applied via ?side='
check 'menu is-open' 'panel still opens on the other edge'
console_clean

echo "== the app section sits apart, at the foot of the rail =="
run ''
check 'rail__item rail__item--bottom' 'app section pinned to the bottom'
console_clean

echo "== about level =="
# The text is read from about.html at runtime, not built into the code.
run 'section=about'
check 'About' 'about title'
check 'class="about"' 'about.html loaded into the level'
check 'WebOCU' 'text of the file rendered'
check 'Version' 'version row taken from appinfo.json'
console_clean

echo "== app properties: expanded selects =="
run 'section=app&expand=appLanguage'
check 'class="options"' 'language options expanded'
check 'English' 'english option'
check 'Русский' 'russian option'
# English is the language of a fresh install, the TV locale is not followed.
check 'class="option is-selected[^"]*" data-id="appLanguage" data-value="en"' 'english selected by default'
absent 'data-id="appLanguage" data-value="system"' 'no System option any more'
console_clean

echo "== theme preview =="
run 'section=app&theme=light'
check 'data-theme="light"' 'light palette applied via ?theme='
# Two switches, four combinations; ?theme=contrast is the older spelling of one.
run 'section=screen&theme=contrast'
check 'data-contrast="on"' 'the old ?theme=contrast still turns contrast on'
check 'data-theme="dark"' 'and leaves the mode where it was'
run 'section=screen&theme=light&contrast=1'
check 'data-theme="light"' 'light contrast: mode kept'
check 'data-contrast="on"' 'light contrast: contrast kept'
console_clean

echo "== pending balloon =="
# Elevation, restart and power off keep this balloon up while they run.
run 'toast=busy'
check 'toast is-open toast--busy\|toast--busy is-open' 'busy toast rendered with the spinner class'
check 'Restarting the TV' 'pending text shown'
console_clean

echo "== panel hidden =="
run 'panel=0'
check 'aria-hidden="true"' 'panel hidden with ?panel=0'
console_clean

# Autostart (Settings -> General): a start made by the TV (?boot=1 stands in for
# params.boot) opens the panel while it is on and quits while it is off, and the
# backdrop (data-shown) exists only while the panel is up. A start the user makes
# is never affected by the switch.
echo "== autostart =="
run 'section=general'
check 'data-id="appOpenAtStart"' 'the Autostart row is in General'
run 'boot=1'
check 'menu is-open' 'boot start with Autostart on opens the panel'
run 'boot=1&openAtStart=0'
absent 'menu is-open' 'boot start with Autostart off draws no panel'
check 'data-shown="off"' 'and leaves no backdrop to catch the pointer'
run 'openAtStart=0'
check 'menu is-open' 'a start by the user ignores the switch'
check 'data-shown="on"' 'the backdrop is there while the panel is up'
console_clean

if [ "$fail" -ne 0 ]; then
  echo "SMOKE: FAILED"
  exit 1
fi
echo "SMOKE: OK"
