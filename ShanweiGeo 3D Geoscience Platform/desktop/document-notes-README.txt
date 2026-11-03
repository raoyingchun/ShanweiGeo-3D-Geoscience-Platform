Document notes (14 October 2026)

Text notes in PDF and Word documents are saved automatically as UTF-8 TXT
700 ms after the user stops typing.

Scribbles are stored in `<name>.annotations.json`, holding the brush strokes,
highlights, eraser strokes and coordinates for each page. Pending changes are
flushed when the document is switched and when the application is closed, and
are redrawn after a reload. Clearing a note writes the same way.

Save directory: the application userData folder, under `document-notes`. File
names contain the original file name plus an identifier generated from the
document type and the original path, so files with the same name in different
directories cannot overwrite one another. When no original path is available,
the type and the name are used as the identifier.

TXT files can be read and edited directly and are read again when the document
is reopened; the JSON scribble data stays recoverable. Do not remove the
suffix identifier or split the file apart — moving a source document to a
different path gives it a new identity.

The original PDF and DOCX files are never modified. Notes and scribbles are
still saved together with the existing project data; the standalone TXT and
JSON files provide autosave and do not require the project to be saved first.

When autosave fails, the interface shows the reason and keeps a localStorage
copy for recovery; closing a page triggers a synchronous IPC save. A single
note is limited to 20 MB. Scribble saving completes the current stroke; a
stroke whose pointer has not been released does not count as a completed
record.

Verification: `node tools/test-document-notes.js`;
`electron tools/test-document-notes-electron.js` verifies the real PDF and
Word interface, TXT writing and scribble restore. The PDF outline isolation
regression passes.
