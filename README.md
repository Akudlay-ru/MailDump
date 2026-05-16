# MailDump

> IMAP mail → clean Markdown digest → structured analysis inside Obsidian.

MailDump is a desktop-only Obsidian plugin for exporting email from IMAP folders into analysis-ready Markdown.

It is built for people who do not need another pretty mailbox. They need a controlled source package: messages, metadata, threads, contacts, unanswered items, attachments when necessary, and a format that can be read by humans, Obsidian, Dataview, scripts, or an LLM.

No CSV graveyard. No fake AI magic. No black-box sync. Just mail pulled into a vault in a form that can be inspected, reused, archived and analyzed.

---

## What MailDump is for

MailDump turns selected IMAP folders into a Markdown digest for operational analysis.

Typical use cases:

- collect project correspondence for a day, week or custom period;
- prepare raw material for management summaries;
- identify subject-based email threads;
- find incoming messages that may still need a reply;
- preserve message metadata for later verification;
- export post-meeting or post-action emails as separate Markdown notes;
- save selected attachment types next to the corresponding mail note.

MailDump is not an email client. It does not replace your mailbox. It extracts the part of the mailbox that matters for analysis and puts it where the work actually happens: in Markdown.

---

## Core features

| Area | What MailDump does |
|---|---|
| IMAP | Connects directly to an IMAP mailbox from Obsidian desktop. |
| Folders | Loads and exports selected IMAP folders. |
| Periods | Supports today, yesterday, work week, last 7 days, last 30 days and custom ranges. |
| Digest | Creates one analysis-ready `.md` digest. |
| Presets | Stores presets in Obsidian plugin `data.json`. |
| Import / export | Allows separate JSON import and export of presets. |
| Threads | Builds subject-based thread keys from normalized subjects. |
| Metadata | Keeps UID, folder, direction, date, sender, recipients, Message-ID, References and flags. |
| Cleanup | Can strip reply chains and signatures. |
| Forwarded mail | Can keep forwarded messages while cutting reply history. |
| Custom marker | Supports a manual reply-chain start marker. |
| Attachments | Can save selected attachment types next to message notes. |
| Unanswered mail | Marks potentially unanswered incoming messages after a configurable threshold. |
| Stop | Can stop the active IMAP operation. |
| Progress | Shows progress in the right panel and Obsidian status bar. |

---

## What the digest contains

A generated digest includes:

1. Run parameters.
2. Technical counters.
3. Active filters.
4. Subject-based thread index.
5. Key contacts.
6. Potentially unanswered incoming messages.
7. Full message list with YAML metadata and message body.

For each message, MailDump can include:

```yaml
uid: "12345"
mailbox: "INBOX"
direction: "incoming"
date: "2026-05-16 18:42:10"
from: "Sender <sender@example.com>"
to: "User <user@example.com>"
cc: "Copy <copy@example.com>"
subject: "Project status"
normalized_subject: "project status"
message_id: "<message-id@example.com>"
in_reply_to: "<previous-message@example.com>"
references: "<thread-reference@example.com>"
thread_key: "subject-based-key"
reference_thread_key: "reference-based-key"
has_attachments: true
attachments_count: 2
unanswered_over_threshold: false
body_length: 1842
```

The body is stored below the YAML block as regular Markdown text.

---

## Installation

### Manual installation

1. Open your Obsidian vault folder.
2. Create the plugin folder:

```text
.obsidian/plugins/maildump/
```

3. Copy these files into the folder:

```text
main.js
manifest.json
styles.css
```

4. Restart Obsidian.
5. Open `Settings → Community plugins`.
6. Enable `MailDump`.

### Community Plugins

After publication in the Obsidian Community Plugins directory, MailDump will be installable through the standard Obsidian plugin browser.

Until then, use manual installation.

---

## Opening the panel

Use the ribbon icon or run the command:

```text
Open MailDump panel
```

Command names are in English for Obsidian compatibility. The plugin interface is in Russian.

---

## Basic setup

Open MailDump settings and configure:

| Setting | Meaning |
|---|---|
| IMAP host | Mail server address, for example `imap.yandex.ru`. |
| IMAP port | Usually `993`. |
| Login | Mail account login. |
| App-password mode | How MailDump handles the IMAP app-password. |
| App-password | Required only if local storage is selected. |
| Additional user addresses | Used to detect incoming / outgoing / CC messages. |
| Key contact email | Optional counter for a specific contact. |
| Output folder | Default: `MailDump`. |
| Timeouts | IMAP connection and command timeouts. |

Use an app-password from your mail provider. Do not use the main account password unless you enjoy turning simple tools into security incidents.

---

## App-password modes

MailDump supports three app-password modes:

| Mode | Result |
|---|---|
| Store in `data.json` | The app-password is stored locally in Obsidian plugin data. Convenient, but you must not publish the file. |
| Ask every time | The app-password is requested before each IMAP operation and is not saved. Safest, least convenient. |
| Remember for session | The app-password is requested once and kept only until Obsidian is restarted. Balanced mode. |

MailDump does not intentionally write the app-password to logs, digests or exported preset files.

Never publish:

```text
data.json
_mail_dump_runs.json
MailDump/
```

---

## Presets

Presets define repeatable export scenarios:

- period;
- IMAP folders;
- output name;
- filters;
- digest fields;
- reply-chain cleanup;
- message note export;
- attachment export rules;
- sorting.

Presets are stored in Obsidian plugin `data.json`, not in a working `presets.json` file.

The panel provides separate buttons for:

- saving the current preset;
- importing presets from JSON;
- exporting presets to JSON.

Exported preset files are written into the configured MailDump output folder.

---

## Export flow

1. Open the MailDump panel.
2. Configure IMAP settings.
3. Load the IMAP folder list.
4. Select folders for the current preset.
5. Choose or create a preset.
6. Select the period.
7. Configure filters and digest content.
8. Press `▶ Пуск`.
9. Open the generated Markdown digest in the output folder.

Default output folder:

```text
MailDump/
```

---

## Filters

MailDump supports include and exclude filters for:

- sender;
- recipient / copy;
- subject.

Filters are applied locally after messages for the selected period are loaded.

This is intentional. IMAP search with Cyrillic subjects is not reliable across mail providers. Predictable local filtering is better than elegant server-side filtering that silently misses messages. Elegant failure is still failure, only with nicer shoes.

---

## Reply-chain cleanup

MailDump can clean message bodies before writing them into the digest.

Available options:

- remove reply chains;
- remove signatures;
- keep forwarded messages;
- use a manual reply-chain marker;
- keep original body without cleanup.

A custom marker is useful when corporate mail templates use stable separators, for example:

```text
----------------
Кому:
```

When the marker is found, MailDump cuts everything below it.

---

## Message notes and attachments

By default, MailDump creates one digest file.

For special scenarios, such as post-meeting mail packages, a preset can also create separate Markdown notes for messages.

If attachment export is enabled, selected attachment extensions are saved next to the corresponding message note. The message note and its attachments share the same timestamp / UID prefix.

Example:

```text
MailDump/Postmits/2026-05-16/
├─ 2026-05-16_18-42-10_12916_Project_status.md
├─ 2026-05-16_18-42-10_12916_minutes.pdf
└─ 2026-05-16_18-42-10_12916_table.xlsx
```

Supported extensions are configured in the preset UI.

---

## Limitations

MailDump deliberately has boundaries:

- desktop Obsidian only;
- no Obsidian mobile support;
- no AI summary generation;
- no delta synchronization;
- no CSV export;
- no background daemon;
- no mailbox editing;
- no sending mail;
- no server-side deletion;
- no deep rewrite of the IMAP/MIME engine in this release.

Current IMAP/MIME processing is built into the plugin and kept intentionally conservative for the first public architecture release.

---

## Privacy and security

MailDump connects from the local Obsidian desktop app to the configured IMAP server.

It writes output files into your vault. It does not send exported mail to third-party services.

Still, the generated digest can contain sensitive correspondence. Treat the output folder as confidential project material.

Do not commit these files:

```text
data.json
_mail_dump_runs.json
MailDump/
```

The included `.gitignore` is there for a reason. A small reason, admittedly, but the kind that prevents large embarrassment.

---

## Versioning

Public versioning starts from:

```text
0.0.1
```

This release is the first public architecture baseline. It is intended to make the plugin clean enough for a public repository and further Community Plugins preparation.

Recommended version policy:

| Version type | Use when |
|---|---|
| `0.0.x` | Public cleanup, fixes, release preparation. |
| `0.x.0` | New feature without a stable public API guarantee. |
| `1.0.0` | Stable public release with finalized baseline behavior. |

---

## License

MIT.

---

# MailDump — русский раздел

> Почта из IMAP → чистый Markdown → управляемая сводка в Obsidian.

MailDump — desktop-only плагин для Obsidian. Он выгружает письма из IMAP-папок и собирает из них Markdown-пакет для анализа.

Не почтовый клиент. Не очередная красивая панелька ради панельки. Не «ИИ сейчас всё сам поймёт», потому что эта сказка обычно заканчивается потерянной задачей и виноватым РП.

MailDump делает более приземлённую вещь: забирает письма, сохраняет метаданные, собирает цепочки, показывает потенциально оставшиеся без ответа входящие и кладёт всё в Markdown.

---

## Для чего это нужно

MailDump нужен, когда почта становится не перепиской, а источником управленческих фактов.

Типовые сценарии:

- собрать почту за день, неделю или произвольный период;
- подготовить сырьё для управленческой сводки;
- разобрать проектную переписку по темам;
- найти входящие, которые могли остаться без ответа;
- сохранить доказуемые метаданные письма;
- выгрузить постмиты отдельными Markdown-файлами;
- положить вложения рядом с конкретным письмом;
- передать digest дальше в ручной или AI-анализ.

Главная идея простая: письмо должно стать нормальным проектным источником, а не утонуть в ящике между рекламой, пересылками и корпоративным фольклором.

---

## Что умеет

| Блок | Возможность |
|---|---|
| IMAP | Подключение к почтовому ящику из desktop Obsidian. |
| Папки | Загрузка списка IMAP-папок и выбор нужных папок. |
| Период | Сегодня, вчера, рабочая неделя, последние 7 / 30 дней, произвольный период. |
| Digest | Один `.md` файл, пригодный для анализа. |
| Пресеты | Сценарии выгрузки хранятся в `data.json`. |
| Импорт / экспорт | Пресеты можно отдельно импортировать и экспортировать в JSON. |
| Цепочки | Группировка по нормализованной теме письма. |
| Метаданные | UID, папка, направление, дата, отправитель, получатели, Message-ID, References, flags. |
| Очистка | Удаление цепочек переписки и подписей. |
| Пересылки | Возможность сохранить пересылаемые письма. |
| Ручной маркер | Можно задать маркер начала старой цепочки. |
| Вложения | Выбранные типы вложений сохраняются рядом с `.md` письма. |
| Без ответа | Входящие старше порога без исходящего ответа помечаются отдельно. |
| Стоп | Активную IMAP-операцию можно остановить. |
| Прогресс | Правый сайдбар и status bar Obsidian. |

---

## Что попадает в digest

Digest содержит:

1. Параметры запуска.
2. Технические счётчики.
3. Фильтры.
4. Индекс цепочек по теме.
5. Ключевые контакты.
6. Потенциально оставшиеся без ответа входящие.
7. Список писем с YAML-метаданными и телом письма.

Пример блока письма:

```yaml
uid: "12345"
mailbox: "INBOX"
direction: "incoming"
date: "2026-05-16 18:42:10"
from: "Иванов Иван <ivanov@example.com>"
to: "Петров Петр <petrov@example.com>"
cc: "Сидоров <sidorov@example.com>"
subject: "Статус по проекту"
normalized_subject: "статус по проекту"
message_id: "<message-id@example.com>"
in_reply_to: "<previous-message@example.com>"
references: "<thread-reference@example.com>"
thread_key: "subject-based-key"
reference_thread_key: "reference-based-key"
has_attachments: true
attachments_count: 2
unanswered_over_threshold: false
body_length: 1842
```

Ниже идёт тело письма обычным Markdown-текстом.

---

## Установка вручную

Создать папку:

```text
.obsidian/plugins/maildump/
```

Скопировать туда:

```text
main.js
manifest.json
styles.css
```

Потом:

1. Перезапустить Obsidian.
2. Открыть `Settings → Community plugins`.
3. Включить `MailDump`.

После публикации в Community Plugins установка будет идти через стандартный каталог Obsidian.

---

## Как открыть

Через ribbon icon или команду Obsidian:

```text
Open MailDump panel
```

Команды Obsidian на английском. Интерфейс панели на русском. Это не раздвоение личности, а нормальная совместимость с каталогом и хоткеями.

---

## Настройка

В настройках плагина указать:

| Настройка | Что означает |
|---|---|
| IMAP host | Адрес сервера, например `imap.yandex.ru`. |
| IMAP port | Обычно `993`. |
| Логин | Логин почтового ящика. |
| Режим app-password | Как хранить или запрашивать пароль приложения. |
| App-password | Нужен, если выбран режим локального хранения. |
| Дополнительные адреса | Чтобы корректно определять входящие, исходящие и копии. |
| Контрольный адрес | Отдельный счётчик по важному контакту. |
| Папка выгрузки | По умолчанию `MailDump`. |
| Таймауты | Таймаут подключения и IMAP-команд. |

Использовать лучше app-password почтового сервиса, а не основной пароль аккаунта.

---

## Хранение app-password

Доступны три режима:

| Режим | Что происходит |
|---|---|
| Хранить в `data.json` | Пароль приложения хранится локально в данных плагина. Удобно, но файл нельзя публиковать. |
| Спрашивать каждый раз | Пароль не сохраняется и запрашивается перед каждой операцией. Безопаснее, но раздражает. |
| Запоминать в рамках сессии | Пароль запрашивается один раз и живёт до перезапуска Obsidian. Нормальный компромисс. |

MailDump не должен писать app-password в логи, digest или экспортированные пресеты.

Не публиковать:

```text
data.json
_mail_dump_runs.json
MailDump/
```

---

## Пресеты

Пресет — это сохранённый сценарий выгрузки:

- период;
- IMAP-папки;
- имя digest;
- фильтры;
- состав полей;
- очистка цепочек;
- создание отдельных `.md` писем;
- сохранение вложений;
- сортировка.

Рабочее хранение пресетов идёт через `data.json`. Внешний `presets.json` не является рабочим хранилищем.

В панели есть отдельные кнопки:

- сохранить текущий пресет;
- импортировать пресеты из JSON;
- экспортировать пресеты в JSON.

---

## Запуск выгрузки

Порядок работы:

1. Открыть панель MailDump.
2. Заполнить настройки IMAP.
3. Загрузить список папок.
4. Выбрать папки в текущем пресете.
5. Выбрать или создать пресет.
6. Задать период.
7. Настроить фильтры и состав digest.
8. Нажать `▶ Пуск`.
9. Открыть созданный `.md` файл в папке выгрузки.

Папка по умолчанию:

```text
MailDump/
```

---

## Фильтры

Фильтры есть по трём полям:

- отправитель;
- кому / копия;
- тема.

Фильтры применяются локально после загрузки писем за период.

Это сделано намеренно: IMAP-поиск по русским темам у разных серверов ведёт себя нестабильно. Лучше загрузить период и отфильтровать предсказуемо, чем красиво не найти половину писем.

---

## Очистка цепочек

MailDump может чистить тело письма перед записью в digest:

- удалять старую переписку;
- удалять подписи;
- сохранять пересылаемые письма;
- использовать ручной маркер начала цепочки;
- оставлять исходный текст без очистки.

Пример ручного маркера:

```text
----------------
Кому:
```

Если маркер найден, всё ниже него вырезается.

---

## Файлы писем и вложения

По умолчанию создаётся один digest.

Для постмитов и похожих сценариев можно включить создание отдельных `.md` файлов писем. Тогда вложения выбранных типов сохраняются рядом с письмом.

Пример:

```text
MailDump/Postmits/2026-05-16/
├─ 2026-05-16_18-42-10_12916_Статус_по_проекту.md
├─ 2026-05-16_18-42-10_12916_протокол.pdf
└─ 2026-05-16_18-42-10_12916_таблица.xlsx
```

У письма и вложений общий префикс по дате, времени и UID. Потом можно понять, что к чему относится, не устраивая археологическую экспедицию по папкам.

---

## Ограничения

В этой версии MailDump не делает:

- мобильную поддержку;
- AI-сводку;
- delta-синхронизацию;
- CSV;
- отправку писем;
- редактирование ящика;
- удаление писем на сервере;
- фоновый демон;
- глубокую переделку IMAP/MIME-движка.

Это сознательная граница версии `0.0.1`: сначала чистая публичная база, потом расширение функциональности.

---

## Безопасность

MailDump подключается к IMAP напрямую из локального Obsidian desktop.

Плагин не отправляет выгруженную почту во внешние сервисы. Но сам digest может содержать чувствительную переписку, поэтому папка выгрузки должна считаться рабочим конфиденциальным материалом.

Не добавлять в Git:

```text
data.json
_mail_dump_runs.json
MailDump/
```

`.gitignore` добавлен не для красоты. Хотя красота там тоже спорная, как и у любого файла, который существует ради предотвращения человеческих ошибок.

---

## Версионирование

Публичная история начинается с:

```text
0.0.1
```

Это первая публичная архитектурная база. Не финальная «мы всё придумали навсегда», а аккуратный старт для репозитория и подготовки к Community Plugins.

Логика версий:

| Версия | Когда использовать |
|---|---|
| `0.0.x` | Чистка, багфиксы, подготовка релиза. |
| `0.x.0` | Новая функция без гарантии стабильной публичной архитектуры. |
| `1.0.0` | Стабильный публичный релиз с закреплённым базовым поведением. |

---

## Лицензия

MIT.
