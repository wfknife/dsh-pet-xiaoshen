; DeskPet installer custom welcome page.
; The chat service (DeepSeek Harness) is installed separately by the user;
; the app itself installs quickly and does not bundle it.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to DeskPet XiaoShen"
  !define MUI_WELCOMEPAGE_TEXT "Welcome to DeskPet XiaoShen.$\r$\n$\r$\nInstallation is quick. The local chat service (DeepSeek Harness) is set up separately - see the in-app guide after installation."
  !insertmacro MUI_PAGE_WELCOME
!macroend
