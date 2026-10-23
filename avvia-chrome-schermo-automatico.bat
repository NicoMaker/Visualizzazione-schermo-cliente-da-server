@echo off
REM Avvia Chrome in modalita' "condivisione automatica": nessuna finestra di scelta,
REM condivide da solo l'INTERO SCHERMO quando premi "Condividi".
REM Uso:  avvia-chrome-schermo-automatico.bat  https://localhost:3002/c/IL_TUO_LINK
REM (senza argomento apre la home del server)
set URL=%~1
if "%URL%"=="" set URL=http://localhost:3002
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe
REM Profilo separato: cosi' le opzioni valgono anche se Chrome e' gia' aperto
start "" "%CHROME%" --user-data-dir="%LocalAppData%\DesktopRemotoChrome" --use-fake-ui-for-media-stream --auto-select-desktop-capture-source="Entire screen" --ignore-certificate-errors --no-first-run "%URL%"
