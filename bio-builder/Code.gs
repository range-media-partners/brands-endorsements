// ============================================================
// Bio Builder — Google Apps Script Backend V2
// Brands & Endorsements
// ============================================================

// --- CONFIGURATION ---
const DRIVE_FOLDER_ID = '1Z4MdMUdXC_P1XU7yTqQ7h4_yREKGbK5E';

// Google Sheet ID:
const SHEET_ID = "1T0Ngu2mg8BocStVKSfkYUVnzzGUPbVmrGYpQYrZyNIU";

// The five tabs we'll be pulling from
const TABS = ["Film/TV", "Musician", "Digital", "Sports", "Culinary"];

// The column names in the Sheet (zero-indexed)
// NOTE: GENDER column sits between NAME and BIOS
const COL = {
  NAME:                0,
  GENDER:              1,
  BIOS:                2,
  EXCLUSIVITY:         3,
  EXCLUSIVITY_SUMMARY: 4,
  RATE_CARDS:          5,
  NOTES:               6
};

// respond helper function
function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// doGet — Called when the frontend loads the page.
// ============================================================
function doGet(e) {
  const action   = e.parameter.action;
  const callback = e.parameter.callback;

  let result;

  if (action === "getRoster") {
    result = getRosterData();
  } else if (action === "generateDocument") {
    const payload = JSON.parse(e.parameter.payload);
    result = generateDocument(
      payload.title,
      payload.featuredNames  || [],
      payload.allSelections  || [],
      payload.groupingMode   || null,
      payload.groups         || null
    );
  } else {
    result = { status: "Bio Builder is running." };
  }

  if (callback) {
    return ContentService
      .createTextOutput(`${callback}(${JSON.stringify(result)})`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// doPost — Handles POST requests (document generation)
// ============================================================
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const result  = generateDocument(
      payload.title,
      payload.featuredNames || [],
      payload.allSelections || [],
      payload.groupingMode  || null,
      payload.groups        || null
    );
    return respond(result);
  } catch (err) {
    return respond({ error: err.message });
  }
}

// ============================================================
// getRoster — Reads all 5 tabs, returns structured roster
// ============================================================
function getRosterData() {
  try {
    const ss     = SpreadsheetApp.openById(SHEET_ID);
    const roster = {};

    TABS.forEach(tabName => {
      const sheet = ss.getSheetByName(tabName);
      if (!sheet) return;

      const rows   = sheet.getDataRange().getValues();
      const people = [];

      for (let i = 1; i < rows.length; i++) {
        const name = rows[i][COL.NAME];
        if (!name || name.toString().trim() === "") continue;
        people.push({
          name:               name.toString().trim(),
          gender:             rows[i][COL.GENDER]?.toString().trim()              || "",
          exclusivity:        rows[i][COL.EXCLUSIVITY]?.toString().trim()         || "",
          exclusivitySummary: rows[i][COL.EXCLUSIVITY_SUMMARY]?.toString().trim() || ""
        });
      }

      roster[tabName] = people;
    });

    return { success: true, roster };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Scales an InlineImage to targetWidth (px) while preserving aspect ratio.
 */
function scaleTo(img, targetWidth) {
  const w = img.getWidth();
  if (!w) return;
  img.setWidth(targetWidth);
  img.setHeight(Math.round(img.getHeight() * (targetWidth / w)));
}

const LOGO_FILE_ID = '1CSga4D_llXhU1qSTKIVyqkcPr7kJcpm5';
const BRAND_COLOR  = '#003e02';

// ============================================================
// generateDocument
//
// featuredNames: [{ name, category }, ...] in user-defined priority order
// allSelections: [{ name, category }, ...] all selected talent
//
// Document order rules:
//   1. "Featured Talent" section: featured names listed in star priority order.
//   2. Categories: featured name categories first (in order of first appearance
//      among featuredNames), then remaining categories in manual order.
//   3. Genders within each category: genders of featured names first (in order
//      of first appearance among featuredNames for that category), then
//      remaining genders in manual order.
//   4. Within each gender group: featured names bubble to top (by their
//      featuredNames index); all others retain their manual allSelections order.
//   5. A blank line separates gender groups within a category.
//   6. A blank line separates categories.
// ============================================================
function generateDocument(docTitle, featuredNames, allSelections, groupingMode, groups) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);

    // ── Build data map keyed by `${category}::${name}` ──────────────────────
    const dataMap     = {};
    const richTextMap = {};

    const categoriesNeeded = [...new Set(allSelections.map(s => s.category))];

    categoriesNeeded.forEach(tabName => {
      const sheet = ss.getSheetByName(tabName);
      if (!sheet) return;

      const rows       = sheet.getDataRange().getValues();
      const namesInTab = new Set(
        allSelections.filter(s => s.category === tabName).map(s => s.name)
      );

      for (let i = 1; i < rows.length; i++) {
        const name = rows[i][COL.NAME]?.toString().trim();
        if (!namesInTab.has(name)) continue;

        const key    = `${tabName}::${name}`;
        dataMap[key] = {
          name,
          category:           tabName,
          gender:             rows[i][COL.GENDER]?.toString().trim()              || '',
          bio:                rows[i][COL.BIOS]?.toString().trim()                || '',
          exclusivity:        rows[i][COL.EXCLUSIVITY]?.toString().trim()         || '',
          exclusivitySummary: rows[i][COL.EXCLUSIVITY_SUMMARY]?.toString().trim() || '',
          rateCard:           rows[i][COL.RATE_CARDS]?.toString().trim()          || '',
          notes:              rows[i][COL.NOTES]?.toString().trim()               || ''
        };

        try {
          richTextMap[key] = sheet.getRange(i + 1, COL.BIOS + 1).getRichTextValue();
        } catch (_) {
          richTextMap[key] = null;
        }
      }
    });

    // ── Build selection groups, recording manual order as fallback ──────────────
    const selectionsByGroup       = {};  // { 'cat::gender': [selections] in appearance order }
    const manualCategoryOrder     = [];
    const manualGendersByCategory = {};

    allSelections.forEach(s => {
      const gender = dataMap[`${s.category}::${s.name}`]?.gender || '';
      const gKey   = `${s.category}::${gender}`;

      if (!manualCategoryOrder.includes(s.category))                 manualCategoryOrder.push(s.category);
      if (!manualGendersByCategory[s.category])                      manualGendersByCategory[s.category] = [];
      if (!manualGendersByCategory[s.category].includes(gender))     manualGendersByCategory[s.category].push(gender);
      if (!selectionsByGroup[gKey])                                   selectionsByGroup[gKey] = [];
      selectionsByGroup[gKey].push(s);
    });

    // ── Featured name priority lookup (bubbles featured to top within each group)
    const featuredKeyOrder = {};
    featuredNames.forEach((f, i) => {
      featuredKeyOrder[`${f.category}::${f.name}`] = i;
    });

    // ── Category order: featured categories first (in featured order),
    //    then remaining categories in manual allSelections order.
    const featuredCategories           = [];
    const featuredGenderLeadByCategory = {};  // { cat: [gender, ...] derived from featuredNames }
    featuredNames.forEach(f => {
      const gender = dataMap[`${f.category}::${f.name}`]?.gender || '';
      if (!featuredCategories.includes(f.category))                          featuredCategories.push(f.category);
      if (!featuredGenderLeadByCategory[f.category])                         featuredGenderLeadByCategory[f.category] = [];
      if (!featuredGenderLeadByCategory[f.category].includes(gender))        featuredGenderLeadByCategory[f.category].push(gender);
    });

    const orderedCategories = [
      ...featuredCategories,
      ...manualCategoryOrder.filter(c => !featuredCategories.includes(c))
    ];

    // ── Gender order per category: featured genders first (in featured order),
    //    then remaining genders in manual allSelections order.
    const orderedGendersByCategory = {};
    orderedCategories.forEach(cat => {
      const featuredGenders = featuredGenderLeadByCategory[cat] || [];
      const manualGenders   = manualGendersByCategory[cat]      || [];
      orderedGendersByCategory[cat] = [
        ...featuredGenders,
        ...manualGenders.filter(g => !featuredGenders.includes(g))
      ];
    });

    // ── Create doc ────────────────────────────────────────────────────────────
    const doc  = DocumentApp.create(docTitle);
    const body = doc.getBody();
    body.clear();
    body.setMarginTop(72);
    body.setMarginBottom(72);
    body.setMarginLeft(72);
    body.setMarginRight(72);

    const logoBlob = DriveApp.getFileById(LOGO_FILE_ID).getBlob();

    // ═════════════════════════════════════════════════════════════════════════
    // FEATURED TALENT section — bold + underlined header, names only (no bios)
    // ═════════════════════════════════════════════════════════════════════════
    if (featuredNames.length > 0) {
      const featHeader = body.appendParagraph('Featured Talent');
      featHeader.setHeading(DocumentApp.ParagraphHeading.HEADING1);
      featHeader.setSpacingBefore(0).setSpacingAfter(0);
      featHeader.editAsText()
        .setFontFamily('Arial').setFontSize(11).setBold(true).setUnderline(false)
        .setForegroundColor('#1A1A1A');

      featuredNames.forEach(f => {
        const namePara = body.appendParagraph(f.name);
        namePara.setSpacingBefore(0).setSpacingAfter(0);
        namePara.editAsText()
          .setFontFamily('Arial').setFontSize(11).setBold(false).setUnderline(false)
          .setForegroundColor('#333333');
      });

      // Blank line separating Featured Talent from first category
      body.appendParagraph('').setSpacingBefore(0).setSpacingAfter(0);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Helper: write a bio paragraph with rich-text formatting
    // ═════════════════════════════════════════════════════════════════════════
    function writeBio(key) {
      const person = dataMap[key];
      if (!person?.bio) return;

      const bioPara = body.appendParagraph(person.bio);
      bioPara.setSpacingBefore(0).setSpacingAfter(0);
      bioPara.editAsText()
        .setFontFamily('Arial').setFontSize(11).setBold(false)
        .setForegroundColor('#333333');

      const richText = richTextMap[key];
      if (richText) {
        const textEl     = bioPara.editAsText();
        const contentLen = textEl.getText().length;
        let pos = 0;
        for (const run of richText.getRuns()) {
          const runLen = run.getText().length;
          if (runLen === 0) continue;
          if (pos >= contentLen) break;
          const endPos = Math.min(pos + runLen - 1, contentLen - 1);
          const url    = run.getLinkUrl();
          const style  = run.getTextStyle();
          if (url) { try { textEl.setLinkUrl(pos, endPos, url); } catch (_) {} }
          if (style.isBold()      !== null) textEl.setBold(pos,      endPos, style.isBold());
          if (style.isItalic()    !== null) textEl.setItalic(pos,    endPos, style.isItalic());
          if (style.isUnderline() !== null) textEl.setUnderline(pos, endPos, style.isUnderline());
          pos += runLen;
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GROUP-BASED sections (Tiers / Categories)
    // ═════════════════════════════════════════════════════════════════════════
    if (groupingMode && groups && groups.length > 0) {
      let isFirstGroup = true;

      groups.forEach(group => {
        // Organise members into talent-category → gender buckets,
        // preserving the drag-drop order of first appearance.
        const catOrder          = [];
        const gendersByCategory = {};
        const membersByBucket   = {};  // 'cat::gender' → [members with bios]

        (group.members || []).forEach(m => {
          const person = dataMap[`${m.category}::${m.name}`];
          if (!person?.bio) return;
          const gender = person.gender || '';
          const gKey   = `${m.category}::${gender}`;
          if (!catOrder.includes(m.category))                  catOrder.push(m.category);
          if (!gendersByCategory[m.category])                  gendersByCategory[m.category] = [];
          if (!gendersByCategory[m.category].includes(gender)) gendersByCategory[m.category].push(gender);
          if (!membersByBucket[gKey])                          membersByBucket[gKey] = [];
          membersByBucket[gKey].push(m);
        });

        // Apply featured-first sort within each gender bucket
        Object.keys(membersByBucket).forEach(gKey => {
          membersByBucket[gKey].sort((a, b) => {
            const aFeat = featuredKeyOrder[`${a.category}::${a.name}`] !== undefined
              ? featuredKeyOrder[`${a.category}::${a.name}`] : Infinity;
            const bFeat = featuredKeyOrder[`${b.category}::${b.name}`] !== undefined
              ? featuredKeyOrder[`${b.category}::${b.name}`] : Infinity;
            return aFeat - bFeat;
          });
        });

        if (catOrder.length === 0) return;

        // Two blank lines between groups, one blank line after Featured Talent
        if (!isFirstGroup) {
          body.appendParagraph('').setSpacingBefore(0).setSpacingAfter(0);
          body.appendParagraph('').setSpacingBefore(0).setSpacingAfter(0);
        }
        isFirstGroup = false;

        // Group label (Tier/Category name) — Heading 1 for sidebar navigation
        const groupLabel = body.appendParagraph(group.name);
        groupLabel.setHeading(DocumentApp.ParagraphHeading.HEADING1);
        groupLabel.setSpacingBefore(0).setSpacingAfter(0);
        groupLabel.editAsText()
          .setFontFamily('Arial').setFontSize(11).setBold(true).setUnderline(false)
          .setForegroundColor('#1A1A1A');

        // Talent categories within this group (mirrors standard-path structure)
        let isFirstCat = true;
        catOrder.forEach(cat => {
          const genders = gendersByCategory[cat] || [];

          // Blank line before each talent category except the first
          if (!isFirstCat) {
            body.appendParagraph('').setSpacingBefore(0).setSpacingAfter(0);
          }
          isFirstCat = false;

          // Talent category label (bold, not a heading — same as standard path)
          const catLabel = body.appendParagraph(cat);
          catLabel.setSpacingBefore(0).setSpacingAfter(0);
          catLabel.editAsText()
            .setFontFamily('Arial').setFontSize(11).setBold(true).setForegroundColor('#1A1A1A');

          // Gender groups within this talent category
          let isFirstGender = true;
          genders.forEach(gender => {
            const members = membersByBucket[`${cat}::${gender}`] || [];
            if (members.length === 0) return;

            // Blank line before each gender group except the first
            if (!isFirstGender) {
              body.appendParagraph('').setSpacingBefore(0).setSpacingAfter(0);
            }
            isFirstGender = false;

            // Bios within the same gender run consecutively with no blank line
            members.forEach(m => writeBio(`${m.category}::${m.name}`));
          });
        });
      });

    // ═════════════════════════════════════════════════════════════════════════
    // STANDARD category sections (no grouping)
    // ═════════════════════════════════════════════════════════════════════════
    } else {
      let isFirstCategory = true;

      orderedCategories.forEach(tabName => {
        const genders = orderedGendersByCategory[tabName] || [];

        const hasAnyone = genders.some(gender =>
          (selectionsByGroup[`${tabName}::${gender}`] || []).some(s => dataMap[`${tabName}::${s.name}`]?.bio)
        );
        if (!hasAnyone) return;

        if (!isFirstCategory) {
          body.appendParagraph('').setSpacingBefore(0).setSpacingAfter(0);
        }
        isFirstCategory = false;

        const catLabel = body.appendParagraph(tabName);
        catLabel.setSpacingBefore(0).setSpacingAfter(0);
        catLabel.editAsText()
          .setFontFamily('Arial').setFontSize(11).setBold(true).setForegroundColor('#1A1A1A');

        let isFirstGenderGroup = true;

        genders.forEach(gender => {
          const people = (selectionsByGroup[`${tabName}::${gender}`] || [])
            .slice()
            .sort((a, b) => {
              const aFeat = featuredKeyOrder[`${tabName}::${a.name}`] !== undefined
                ? featuredKeyOrder[`${tabName}::${a.name}`] : Infinity;
              const bFeat = featuredKeyOrder[`${tabName}::${b.name}`] !== undefined
                ? featuredKeyOrder[`${tabName}::${b.name}`] : Infinity;
              return aFeat - bFeat;
            })
            .filter(s => dataMap[`${tabName}::${s.name}`]?.bio);

          if (people.length === 0) return;

          if (!isFirstGenderGroup) {
            body.appendParagraph('').setSpacingBefore(0).setSpacingAfter(0);
          }
          isFirstGenderGroup = false;

          people.forEach(s => writeBio(`${tabName}::${s.name}`));
        });
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // FOOTER — "Confidential" left | small logo right
    // ═════════════════════════════════════════════════════════════════════════
    const footer = doc.getFooter() || doc.addFooter();
    footer.clear();

    const ftTable = footer.appendTable([['', '']]);
    ftTable.setBorderWidth(0);

    const confPara = ftTable.getCell(0, 0).getChild(0).asParagraph();
    confPara.appendText('Confidential');
    confPara.setAlignment(DocumentApp.HorizontalAlignment.LEFT);
    confPara.editAsText()
      .setFontFamily('Arial').setFontSize(8).setItalic(true).setForegroundColor('#BBBBBB');

    const logoFooterPara = ftTable.getCell(0, 1).getChild(0).asParagraph();
    logoFooterPara.setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
    scaleTo(logoFooterPara.appendInlineImage(logoBlob), 72);

    // ── Save to Drive ─────────────────────────────────────────────────────────
    const docFile = DriveApp.getFileById(doc.getId());
    if (DRIVE_FOLDER_ID) {
      const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
      folder.addFile(docFile);
      DriveApp.getRootFolder().removeFile(docFile);
    }

    doc.saveAndClose();

    return {
      success:  true,
      docUrl:   'https://docs.google.com/document/d/' + doc.getId() + '/edit',
      docTitle: docTitle
    };

  } catch (err) {
    return { success: false, error: err.message };
  }
}
