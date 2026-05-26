# 09. CoreS3 LCD / SD shared SPI safety

## Symptoms

- LCD stays black during cold boot, reset boot, or HERMES startup.
- Display contents become corrupted after setup or app navigation.
- Logs may still show `Hermes avatar SetupUI complete`, `Application::Run start`, `SetStatus: Standby`, and `Start idle motion`.

These logs prove that LVGL objects and runtime tasks advanced. They do not prove that the physical LCD panel IO, SPI3 bus, or GPIO35/DC state is healthy.

## Cause

M5Stack CoreS3 / StackChan shares SPI3 between the LCD and SD card. GPIO35 is used as LCD DC and SD MISO. SD card access while LCD display is active, just before display initialization, or just before HERMES handoff can leave the LCD bus in a bad state.

Specific hazards:

- SD_CS(GPIO4) or LCD_CS(GPIO3) not forced inactive high before SPI3 initialization.
- Application code directly calling `esp_lcd_panel_draw_bitmap()` outside LVGL / esp_lvgl_port.
- Launcher, HERMES open, or setup connectivity code implicitly importing SD config.
- Continuing directly into HERMES after SD config import without rebooting.
- Treating `restore_shared_spi_for_display()` as a complete recovery mechanism.

## Fix

- Force SD_CS(GPIO4) and LCD_CS(GPIO3) high before `spi_bus_initialize()`.
- Do not direct-draw to the LCD from application, boot clear, or handoff code.
- Do not auto-import SD config from Launcher startup, HERMES app open, or connectivity checks.
- Keep SD config import behind the explicit Setup > Load SD Config action.
- Require restart after successful SD config import.
- Store imported settings in NVS and read NVS during normal boot and HERMES startup.

## Verification

- Cold boot without SD card.
- Cold boot with SD card.
- Warm reboot via reset button.
- Setup > Load SD Config with redacted config values such as `<redacted>`.
- Confirm the success screen says restart is required.
- Reboot after SD import and confirm Launcher appears.
- Start HERMES manually.
- Confirm HERMES startup does not access SD card.
- Confirm StackChan face appears and no black screen, bottom band, or corruption remains.

Do not record Wi-Fi password, private WebSocket URL, token, personal IP address, or full credential material in logs or docs.
