# 09. CoreS3 LCD / SD shared SPI safety

## Symptoms

- LCD stays black during cold boot, reset boot, or HERMES startup.
- Display contents become corrupted after setup or app navigation.
- HERMES launcher icon, text, or avatar fragments repeat in a narrow vertical band.
- Launcher geometry looks correct but colors are wrong, such as a blue/purple tint or incorrect text color.
- Touch or swipe transitions intermittently black out the panel while servo/runtime tasks continue.
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
- Raising LCD SPI clock or transfer queue depth after SD interaction.
- Disabling RGB565 byte swapping to avoid black screens. That can make frame geometry appear stable, but the LCD colors are wrong.
- Doing RGB565 byte swapping in a way that mutates LVGL's active draw buffer before the asynchronous LCD transfer has safely consumed it.

## Fix

- Force SD_CS(GPIO4) and LCD_CS(GPIO3) high before `spi_bus_initialize()`.
- Do not direct-draw to the LCD from application, boot clear, or handoff code.
- Do not auto-import SD config from Launcher startup, HERMES app open, or connectivity checks.
- Keep SD config import behind the explicit Setup > Load SD Config action.
- Setup > Load SD Config must schedule boot-time import, reboot before touching SD, import before LCD initialization, then reboot again into normal startup.
- Store imported settings in NVS and read NVS during normal boot and HERMES startup.
- Keep LCD SPI transfer settings conservative on CoreS3 / StackChan. The verified setting is 20 MHz pixel clock with transfer queue depth 2.
- Keep LVGL display `.swap_bytes = 1` for the CoreS3 LCD color order.
- Apply the `esp-lvgl-port-rgb565-swap-buffer.patch` patch so RGB565 byte swapping copies into a dedicated transfer buffer instead of mutating the active LVGL draw buffer in place.

## Do not regress these settings

- Do not restore LCD SPI clock to 40 MHz or transfer queue depth to 10 without a full physical LCD regression pass.
- Do not remove `.swap_bytes = 1` from `StackChanAvatarDisplay::SetupUI()` just because it appears to reduce black screens; it reintroduces the wrong-color failure.
- Do not remove the `esp_lvgl_port` RGB565 swap-buffer patch while keeping `.swap_bytes = 1`; that combination can reintroduce black screens or repeated corrupted fragments.
- Do not add SD probe, mount, or config import to Launcher startup, HERMES app open, HERMES handoff, or any retry/error UI.
- Do not call servo motion from inside the display lock; keep LVGL/display object updates and servo I/O separated.

## Verification

- Cold boot without SD card.
- Cold boot with SD card.
- Warm reboot via reset button.
- Setup > Load SD Config with redacted config values such as `<redacted>`.
- Confirm the device reboots before SD access, imports config before LCD init, reboots again, and then shows Launcher.
- Start HERMES manually.
- Confirm HERMES startup does not access SD card.
- Confirm StackChan face appears and no black screen, bottom band, or corruption remains.
- Confirm Launcher color and HERMES icon color match the expected palette after `.swap_bytes = 1`.
- Swipe through Launcher pages and enter/exit standby-like transitions repeatedly.
- Confirm logs do not show LVGL flush, LCD DMA, or display buffer allocation failures.

Do not record Wi-Fi password, private WebSocket URL, token, personal IP address, or full credential material in logs or docs.
