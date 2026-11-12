const DEFAULT_SETTINGS = {
  marginX: 48,
  marginY: 36,
  baseFontSize: 13,
  headingFontSize: 15,
  nameFontSize: 21,
  lineHeight: 1.48,
  paragraphGap: 3,
  normalTextDepth: 28,
  fontFamily: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif',
  photo: "",
  photoWidth: 25,
};

const STORAGE_KEYS = {
  settings: "resume-template-settings",
  images: "resume-template-images",
};

const PHOTO_MAX_SIDE = 900;
const IMAGE_MAX_SIDE = 1400;

let isLoadingMarkdown = false;
let markdownFileHandle = null;
let lastKnownFileModified = 0;
let pendingSaveTimer = null;
let hasPendingLocalSave = false;
let isWritingMarkdown = false;
let currentPhoto = "";
let imageLibrary = {};
let selectedImageId = null;

const els = {
  preview: document.querySelector("#resumePreview"),
  markdown: document.querySelector("#markdownInput"),
  printBtn: document.querySelector("#printBtn"),
  openMdBtn: document.querySelector("#openMdBtn"),
  fileStatus: document.querySelector("#fileStatus"),
  marginX: document.querySelector("#marginX"),
  marginY: document.querySelector("#marginY"),
  baseFontSize: document.querySelector("#baseFontSize"),
  headingFontSize: document.querySelector("#headingFontSize"),
  nameFontSize: document.querySelector("#nameFontSize"),
  lineHeight: document.querySelector("#lineHeight"),
  paragraphGap: document.querySelector("#paragraphGap"),
  normalTextDepth: document.querySelector("#normalTextDepth"),
  fontFamily: document.querySelector("#fontFamily"),
  photoWidth: document.querySelector("#photoWidth"),
  photoFile: document.querySelector("#photoFile"),
  photoStatus: document.querySelector("#photoStatus"),
  choosePhotoBtn: document.querySelector("#choosePhotoBtn"),
  removePhotoBtn: document.querySelector("#removePhotoBtn"),
  addImageBtn: document.querySelector("#addImageBtn"),
  imageFile: document.querySelector("#imageFile"),
  imageList: document.querySelector("#imageList"),
  imageHint: document.querySelector("#imageHint"),
  imageEditor: document.querySelector("#imageEditor"),
  imageFreeBtn: document.querySelector("#imageFreeBtn"),
  imageWidth: document.querySelector("#imageWidth"),
  imageAlign: document.querySelector("#imageAlign"),
  imageMoveUp: document.querySelector("#imageMoveUp"),
  imageMoveDown: document.querySelector("#imageMoveDown"),
  imageRemove: document.querySelector("#imageRemove"),
};

const outputs = {
  marginX: document.querySelector("#marginXValue"),
  marginY: document.querySelector("#marginYValue"),
  baseFontSize: document.querySelector("#baseFontSizeValue"),
  headingFontSize: document.querySelector("#headingFontSizeValue"),
  nameFontSize: document.querySelector("#nameFontSizeValue"),
  lineHeight: document.querySelector("#lineHeightValue"),
  paragraphGap: document.querySelector("#paragraphGapValue"),
  normalTextDepth: document.querySelector("#normalTextDepthValue"),
  photoWidth: document.querySelector("#photoWidthValue"),
  imageWidth: document.querySelector("#imageWidthValue"),
};

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeImageSrc(src) {
  const value = src.trim();

  if (!value) {
    return value;
  }

  // Windows 盘符路径：C:\a\b.png / C:/a/b.png → file:///C:/a/b.png
  if (/^[a-z]:[\\/]/i.test(value)) {
    return `file:///${value.replaceAll("\\", "/")}`;
  }

  // 已有协议（http:、https:、data:、file:、blob: 等）原样保留
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return value;
  }

  // 其余按相对路径处理，反斜杠统一成正斜杠
  return value.replaceAll("\\", "/");
}

// 行内占位符，避免 Markdown 生成的 HTML 被二次转义
const INLINE_TOKEN_PATTERN = /\uE000(\d+)\uE001/g;

// img:xxx 引用的是面板里“正文图片”图片库中的条目
function resolveImageSrc(src) {
  const value = src.trim();
  const match = /^img:([\w-]+)$/.exec(value);

  if (!match) {
    return { src: normalizeImageSrc(value), id: "" };
  }

  const entry = imageLibrary[match[1]];
  return { src: entry ? entry.dataUrl : value, id: match[1] };
}

function renderInline(text) {
  const tokens = [];
  const stash = (html) => {
    const token = `\uE000${tokens.length}\uE001`;
    tokens.push(html);
    return token;
  };

  // 1. 先把图片摘出来，这样 src / alt 不会被当作普通文本转义
  const withImages = text.replace(
    /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^()\s]+))(?:\s+"([^"]*)")?\s*\)/g,
    (_, alt, angleSrc, plainSrc, title = "") => {
      const src = angleSrc || plainSrc;
      const parts = title.trim().split(/\s+/).filter(Boolean);
      const size = parts.find((part) => /^\d+(?:\.\d+)?(?:px|mm|cm|in|pt|em|%)$/.test(part)) || "";
      const align = parts.find((part) => part === "right" || part === "left") || "";
      const at = parts.find((part) => /^at=\d+(?:\.\d+)?,\d+(?:\.\d+)?$/.test(part)) || "";
      const plainTitle = parts.filter((part) => part !== size && part !== align && part !== at).join(" ");

      const classes = ["resume-image"];
      const styles = [];
      const freeAttrs = [];

      if (size) {
        styles.push(`width:${size}`);
      }

      if (at) {
        // 自由位置：相对正文左上角的毫米数（按纸面算，不随自适应缩放漂移）
        const [x, y] = at.slice(3).split(",");
        classes.push("is-free");
        freeAttrs.push(` data-free-x="${x}"`, ` data-free-y="${y}"`);
      } else if (align) {
        classes.push(align === "right" ? "is-align-right" : "is-align-left");
      }

      const titleAttr = plainTitle ? ` title="${escapeHtml(plainTitle)}"` : "";
      const resolved = resolveImageSrc(src);
      const imageId = resolved.id;

      if (imageId && imageId === selectedImageId) {
        classes.push("is-selected");
      }

      const imageIdAttr = imageId ? ` data-img-id="${imageId}"` : "";
      const styleAttr = styles.length ? ` style="${styles.join(";")}"` : "";

      return stash(
        `<img class="${classes.join(" ")}" src="${escapeHtml(resolved.src)}" alt="${escapeHtml(alt)}" decoding="async"${imageIdAttr}${freeAttrs.join("")}${titleAttr}${styleAttr} />`,
      );
    },
  );

  // 2. 再转义 + 处理行内标记
  let safe = escapeHtml(withImages);

  safe = safe.replace(/`([^`]+)`/g, (_, label) => stash(`<span class="tag">${label}</span>`));
  safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  return safe.replace(INLINE_TOKEN_PATTERN, (_, index) => tokens[Number(index)]);
}

function stripOuterBold(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^\*\*(.*)\*\*$/);
  return match ? match[1].trim() : trimmed;
}

function splitTrailingDate(text) {
  const cleaned = stripOuterBold(text);
  const datePattern = /\s*([（(]\s*(?:\d{4}\.\d{2}|至今|现在|Present|present)\s*[-~至]\s*(?:\d{4}\.\d{2}|至今|现在|Present|present)\s*[）)])\s*$/;
  const match = cleaned.match(datePattern);

  if (!match) {
    return null;
  }

  return {
    main: cleaned.slice(0, match.index).trim(),
    date: match[1].trim(),
  };
}

function isStrongOnlyLine(line) {
  return /^\*\*.+\*\*$/.test(line.trim());
}

// 整行只有一张图片（不含其他文字）
function isImageOnlyLine(line) {
  return /^!\[[^\]]*\]\(.+\)$/.test(line.trim());
}

// 关闭姓名区；姓名区里攒下的图片行统一补在 </header> 之后，避免图片挤进姓名块
function closeHeader(state, html) {
  if (state.headerComplete) {
    return;
  }

  state.headerComplete = true;
  html.push("</header>");

  if (state.deferred.length) {
    html.push(...state.deferred);
    state.deferred = [];
  }
}

function renderDatedLine(line) {
  const parts = splitTrailingDate(line);
  if (!parts) {
    return null;
  }

  return `<div class="entry-row"><div class="entry-main">${renderInline(parts.main)}</div><time class="entry-date">${escapeHtml(parts.date)}</time></div>`;
}

function closeList(state, html) {
  if (!state.listType) {
    return;
  }
  html.push(`</${state.listType}>`);
  state.listType = null;
}

function renderBodyLine(line) {
  const dated = renderDatedLine(line);
  if (dated) {
    return dated;
  }

  if (isStrongOnlyLine(line)) {
    const label = stripOuterBold(line);
    if (/^(项目描述|主要工作|项目职责|技术栈|项目亮点|成果)[:：]?$/.test(label)) {
      return `<h4>${renderInline(label)}</h4>`;
    }
    return `<h3>${renderInline(label)}</h3>`;
  }

  return `<p>${renderInline(line)}</p>`;
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  const state = { listType: null, inSection: false, headerComplete: false, headerOpen: false, deferred: [] };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      closeList(state, html);
      continue;
    }

    if (line.startsWith("# ")) {
      closeList(state, html);
      if (state.inSection) {
        html.push("</section>");
        state.inSection = false;
      }
      html.push(`<header class="resume-header"><h1>${renderInline(line.slice(2).trim())}</h1>`);
      state.headerComplete = false;
      state.headerOpen = true;
      continue;
    }

    if (line.startsWith("## ")) {
      closeList(state, html);
      closeHeader(state, html);
      if (state.inSection) {
        html.push("</section>");
      }
      html.push(`<section class="section"><h2 class="section-title">${renderInline(line.slice(3).trim())}</h2>`);
      state.inSection = true;
      continue;
    }

    if (line === "---") {
      closeList(state, html);
      html.push('<hr class="project-separator" />');
      continue;
    }

    // 姓名和联系方式之间的图片行先记下来，等姓名区关闭后补到正文里
    if (state.headerOpen && !state.headerComplete && !state.inSection && isImageOnlyLine(line)) {
      state.deferred.push(`<p>${renderInline(line)}</p>`);
      continue;
    }

    if (!state.headerComplete && !state.inSection) {
      html.push(`<p>${renderInline(line)}</p>`);
      closeHeader(state, html);
      continue;
    }

    const ordered = line.match(/^\d+\.\s+(.+)$/);
    const unordered = line.match(/^[-*]\s+(.+)$/);
    if (ordered || unordered) {
      const listType = ordered ? "ol" : "ul";
      if (state.listType !== listType) {
        closeList(state, html);
        html.push(`<${listType}>`);
        state.listType = listType;
      }
      html.push(`<li>${renderInline((ordered || unordered)[1])}</li>`);
      continue;
    }

    closeList(state, html);
    html.push(renderBodyLine(line));
  }

  closeList(state, html);
  closeHeader(state, html);
  if (state.inSection) {
    html.push("</section>");
  }

  return html.join("");
}

function normalTextColor(depth) {
  const lightness = 4 + depth * 0.68;
  return `hsl(210 19% ${lightness.toFixed(1)}%)`;
}

function fitToOnePage() {
  const content = els.preview.querySelector(".resume-content");
  if (!content) {
    return;
  }

  // 自由拖动的图片脱离文档流，测量时先排除，避免把整页缩小
  const freeImages = [...content.querySelectorAll(".resume-image.is-free")];
  freeImages.forEach((img) => {
    img.dataset.previousDisplay = img.style.display;
    img.style.display = "none";
  });

  document.documentElement.style.setProperty("--fit-scale", "1");
  content.style.width = "100%";

  const pageStyle = getComputedStyle(els.preview);
  const availableHeight = els.preview.clientHeight - parseFloat(pageStyle.paddingTop) - parseFloat(pageStyle.paddingBottom);
  const contentHeight = content.scrollHeight;
  const scale = Math.min(1, availableHeight / Math.max(contentHeight, 1));
  const rounded = scale.toFixed(4);

  document.documentElement.style.setProperty("--fit-scale", rounded);
  content.style.width = `calc(100% / ${rounded})`;

  freeImages.forEach((img) => {
    img.style.display = img.dataset.previousDisplay || "";
    delete img.dataset.previousDisplay;
  });

  // 缩放变了，自由定位的图片要按新比例重算坐标
  applyFreePositions();
}

function markImageMissing(img) {
  const src = img.getAttribute("src") || "";
  img.classList.add("is-missing");
  console.warn(`[resume] 图片未能加载：${src}`);
  setStatus(`图片未能加载：${src}（相对路径以 index.html 所在目录为基准）`);
}

// 等一张图片加载完成（成功或失败都会 resolve），用于重算缩放与打印前等待
function settleImage(img) {
  if (img.complete) {
    if (!img.naturalWidth) {
      markImageMissing(img);
    }
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      if (!img.naturalWidth) {
        markImageMissing(img);
      }
      resolve();
    };
    const timer = setTimeout(finish, 5000);

    img.addEventListener("load", finish, { once: true });
    img.addEventListener("error", finish, { once: true });
  });
}

function settleAllImages() {
  const images = [...els.preview.querySelectorAll("img.resume-image, img.resume-photo")];
  if (!images.length) {
    return Promise.resolve();
  }
  return Promise.all(images.map(settleImage)).then(() => {
    fitToOnePage();
  });
}

async function handlePrint() {
  // 图片没解码完就打印会印出空白或缺内容，先等图片就绪再唤起打印
  await settleAllImages();
  window.print();
}

function setStatus(message) {
  els.fileStatus.textContent = message;
}

// 证件照：独立的图片资源，由控制面板选择，和 Markdown 里的图片互不影响
function renderPhoto() {
  const content = els.preview.querySelector(".resume-content");
  if (!content || !currentPhoto) {
    return;
  }

  const img = document.createElement("img");
  img.className = "resume-photo";
  img.src = currentPhoto;
  img.alt = "证件照";
  img.decoding = "async";

  const header = content.querySelector(".resume-header");
  if (header) {
    header.appendChild(img);
  } else {
    content.prepend(img);
  }
}

function updatePhotoStatus() {
  els.photoStatus.textContent = currentPhoto
    ? `已设置证件照，打印宽度 ${els.photoWidth.value}mm。`
    : "未设置证件照。";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

// 统一缩放后转 JPEG data URL，避免 localStorage 超限
async function imageFileToDataUrl(file, maxSide, quality) {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => resolve(probe);
      probe.onerror = () => reject(new Error("无法解析这张图片"));
      probe.src = objectUrl;
    });

    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    return canvas.toDataURL("image/jpeg", quality);
  } catch (error) {
    // 解码失败时退回原始文件（例如矢量图）
    return await readFileAsDataUrl(file).catch(() => {
      throw error;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function fileToPhotoDataUrl(file) {
  return imageFileToDataUrl(file, PHOTO_MAX_SIDE, 0.92);
}

async function handlePhotoFile(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    currentPhoto = await fileToPhotoDataUrl(file);
    renderAndPersist();
    setStatus(`已添加证件照：${file.name}`);
  } catch (error) {
    setStatus(`证件照导入失败：${error.message}`);
  } finally {
    event.target.value = "";
  }
}

function removePhoto() {
  currentPhoto = "";
  renderAndPersist();
  setStatus("已移除证件照。");
}

/* ---------------- 正文图片：库 + 插入 + 调大小/位置 ---------------- */

const PX_PER_MM = 96 / 25.4;

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function getFitScale() {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fit-scale")) || 1;
}

// 预览区用的是 transform: scale，指针坐标要除以缩放比才是排版坐标
function getPreviewMetrics() {
  const content = els.preview.querySelector(".resume-content");
  // #resumePreview 本身就是 .resume-page，页面尺寸从它身上取
  const page = els.preview;
  if (!content || !page) {
    return null;
  }

  const scale = getFitScale();
  const pageStyle = getComputedStyle(page);
  const padX = Number.parseFloat(pageStyle.paddingLeft) || 0;
  const padY = Number.parseFloat(pageStyle.paddingTop) || 0;

  return {
    content,
    contentRect: content.getBoundingClientRect(),
    scale,
    // 纸张正文区的物理像素尺寸（未缩放）
    innerWidth: page.clientWidth - padX * 2,
    innerHeight: page.clientHeight - padY * 2,
  };
}

// 自由定位的图片：把 Markdown 里的纸面毫米坐标换算成当前缩放下的布局坐标，
// 这样整页缩放变化时，图片不会在纸上漂移
function applyFreePositions() {
  const images = els.preview.querySelectorAll("img.resume-image.is-free");
  if (!images.length) {
    return;
  }

  const scale = getFitScale();
  const metrics = getPreviewMetrics();
  images.forEach((img) => {
    const x = Number(img.dataset.freeX) || 0;
    const y = Number(img.dataset.freeY) || 0;

    let leftMm = x;
    let topMm = y;

    if (metrics) {
      // 页面缩放变化后图片可能顶出纸张，按当前尺寸收回来
      const rect = img.getBoundingClientRect();
      const maxLeftMm = Math.max(0, metrics.innerWidth - rect.width) / PX_PER_MM;
      const maxTopMm = Math.max(0, metrics.innerHeight - rect.height) / PX_PER_MM;
      leftMm = Math.min(leftMm, maxLeftMm);
      topMm = Math.min(topMm, maxTopMm);
    }

    img.style.left = `${leftMm / scale}mm`;
    img.style.top = `${topMm / scale}mm`;
  });
}

function readImageLibrary() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEYS.images) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function saveImageLibrary() {
  try {
    localStorage.setItem(STORAGE_KEYS.images, JSON.stringify(imageLibrary));
  } catch (error) {
    setStatus(`图片库保存失败（浏览器存储可能已满）：${error.message}`);
  }
}

// 找到某个图片在 Markdown 里的引用，解析出宽度和对齐
function findImageToken(markdown, id) {
  const pattern = new RegExp(`!\\[([^\\]]*)\\]\\(\\s*img:${id}(?:\\s+"([^"]*)")?\\s*\\)`);
  const match = pattern.exec(markdown);

  if (!match) {
    return null;
  }

  const title = match[2] || "";
  const parts = title.split(/\s+/).filter(Boolean);
  const widthPart = parts.find((part) => /^\d+(?:\.\d+)?(?:px|mm|cm|in|pt|em|%)$/.test(part)) || "";
  const align = parts.find((part) => part === "left" || part === "right") || "center";
  const at = parts.find((part) => /^at=\d+(?:\.\d+)?,\d+(?:\.\d+)?$/.test(part)) || "";
  const widthMm = Number.parseFloat(widthPart) || Number.parseFloat(els.imageWidth.value) || 80;

  let x = 0;
  let y = 0;
  if (at) {
    const [rawX, rawY] = at.slice(3).split(",");
    x = Number(rawX) || 0;
    y = Number(rawY) || 0;
  }

  return {
    match: match[0],
    index: match.index,
    alt: match[1] || "图片",
    widthMm,
    unit: widthPart.replace(/^[\d.]+/, "") || "mm",
    align,
    free: Boolean(at),
    x,
    y,
  };
}

function buildImageToken(id, alt, widthMm, align, free = false, x = 0, y = 0) {
  const size = `${roundOne(widthMm)}mm`;
  if (free) {
    return `![${alt}](img:${id} "${size} at=${roundOne(x)},${roundOne(y)}")`;
  }
  const title = align === "center" ? size : `${size} ${align}`;
  return `![${alt}](img:${id} "${title}")`;
}

// 就地替换 Markdown 里的那条图片引用
function replaceImageToken(id, build) {
  const token = findImageToken(els.markdown.value, id);
  if (!token) {
    return null;
  }

  const replacement = build(token);
  const value = els.markdown.value;
  els.markdown.value = value.slice(0, token.index) + replacement + value.slice(token.index + token.match.length);
  return token;
}

function renderImageList() {
  const ids = Object.keys(imageLibrary);
  els.imageList.replaceChildren();
  els.imageList.hidden = ids.length === 0;

  ids.forEach((id) => {
    const entry = imageLibrary[id];
    const button = document.createElement("button");
    button.type = "button";
    button.className = id === selectedImageId ? "image-item is-active" : "image-item";
    button.title = entry.name || "图片";

    const thumb = document.createElement("img");
    thumb.src = entry.dataUrl;
    thumb.alt = entry.name || "图片";
    button.appendChild(thumb);

    button.addEventListener("click", () => selectImage(id));
    els.imageList.appendChild(button);
  });
}

function selectImage(id) {
  selectedImageId = id in imageLibrary ? id : null;
  const token = selectedImageId ? findImageToken(els.markdown.value, selectedImageId) : null;

  // 图片还在库里就给个编辑面板；没插进简历时禁用尺寸控制，但仍可删除
  els.imageEditor.hidden = !selectedImageId;
  const disabled = !token;
  const free = Boolean(token?.free);
  els.imageWidth.disabled = disabled;
  els.imageAlign.disabled = disabled || free;
  els.imageMoveUp.disabled = disabled || free;
  els.imageMoveDown.disabled = disabled || free;
  els.imageFreeBtn.disabled = disabled;
  els.imageFreeBtn.textContent = free ? "回到正文" : "转为自由位置";

  if (token) {
    els.imageWidth.value = String(token.widthMm);
    els.imageAlign.value = token.align;
    outputs.imageWidth.textContent = `${roundOne(token.widthMm)}mm`;
    els.imageHint.textContent = free
      ? `自由位置：x ${roundOne(token.x)}mm，y ${roundOne(token.y)}mm，可直接拖图调整。`
      : "已选中图片，可调宽度和位置，也可以直接拖动。";
  } else if (selectedImageId) {
    els.imageHint.textContent = "这张图片没有插入到简历里，可以直接删掉。";
  } else {
    els.imageHint.textContent = "选一张本地图片，会插入到 Markdown 光标处。";
  }

  // 同步选中描边
  els.preview.querySelectorAll("img.is-selected").forEach((img) => img.classList.remove("is-selected"));
  if (selectedImageId) {
    els.preview.querySelectorAll(`img[data-img-id="${selectedImageId}"]`).forEach((img) => img.classList.add("is-selected"));
  }

  renderImageList();
}

// 用当前的宽度/位置改写 Markdown 里那条图片引用
function applyImageSettings() {
  if (!selectedImageId) {
    return;
  }

  const token = replaceImageToken(selectedImageId, (current) => {
    const widthMm = Number(els.imageWidth.value);
    // 自由位置的图片改宽度时保留坐标；改对齐则回到正文流
    const free = current.free && els.imageAlign.value === current.align;
    return buildImageToken(selectedImageId, current.alt, widthMm, free ? current.align : els.imageAlign.value, free, current.x, current.y);
  });

  if (!token) {
    return;
  }

  selectImage(selectedImageId);
  renderAndPersist();
}

// 图片当前在页面上的位置（物理 mm，相对正文左上角）
function measureImagePosition(id) {
  const img = els.preview.querySelector(`img[data-img-id="${id}"]`);
  const metrics = getPreviewMetrics();
  if (!img || !metrics) {
    return { x: 0, y: 0 };
  }

  const rect = img.getBoundingClientRect();
  return {
    x: roundOne((rect.left - metrics.contentRect.left) / PX_PER_MM),
    y: roundOne((rect.top - metrics.contentRect.top) / PX_PER_MM),
  };
}

// 正文流 ⇄ 自由位置
function toggleFreeMode() {
  if (!selectedImageId) {
    return;
  }

  const token = findImageToken(els.markdown.value, selectedImageId);
  if (!token) {
    return;
  }

  if (token.free) {
    replaceImageToken(selectedImageId, (current) =>
      buildImageToken(selectedImageId, current.alt, current.widthMm, els.imageAlign.value || "center", false),
    );
    setStatus("已回到正文排版。");
  } else {
    const { x, y } = measureImagePosition(selectedImageId);
    replaceImageToken(selectedImageId, (current) =>
      buildImageToken(selectedImageId, current.alt, current.widthMm, current.align, true, x, y),
    );
    setStatus("已转为自由位置，直接拖动图片即可摆放。");
  }

  selectImage(selectedImageId);
  renderAndPersist();
}

/* ---------------- 拖动图片 ---------------- */

let dragState = null;

function handlePreviewPointerDown(event) {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.imgId || !imageLibrary[img.dataset.imgId]) {
    return;
  }
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  dragState = {
    img,
    id: img.dataset.imgId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startRect: img.getBoundingClientRect(),
    active: false,
    metrics: null,
    grabX: 0,
    grabY: 0,
  };
}

// 把物理像素位置写回元素（元素在缩放层里，需要除以 scale）
function placeImage(img, physicalLeftPx, physicalTopPx, scale) {
  img.style.left = `${physicalLeftPx / scale}px`;
  img.style.top = `${physicalTopPx / scale}px`;
  img.dataset.freeX = String(roundOne(physicalLeftPx / PX_PER_MM));
  img.dataset.freeY = String(roundOne(physicalTopPx / PX_PER_MM));
}

function activateDrag() {
  const { img, startRect } = dragState;
  const metrics = getPreviewMetrics();
  if (!metrics) {
    dragState = null;
    return;
  }

  // 抓取点以按下时的位置为准，避免拖动开始时图片落后于指针
  dragState.metrics = metrics;
  dragState.grabX = dragState.startX - startRect.left;
  dragState.grabY = dragState.startY - startRect.top;
  dragState.active = true;

  if (!img.classList.contains("is-free")) {
    // 从正文流切成自由定位，先保持当前位置，避免跳一下
    img.classList.add("is-free");
    img.classList.remove("is-align-left", "is-align-right");
    img.style.margin = "0";
    placeImage(img, startRect.left - metrics.contentRect.left, startRect.top - metrics.contentRect.top, metrics.scale);
  }

  img.classList.add("is-dragging");
  if (selectedImageId !== dragState.id) {
    selectImage(dragState.id);
  }
}

function handlePointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  if (!dragState.active) {
    const moved = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
    if (moved < 4) {
      return;
    }
    activateDrag();
  }

  const { img, metrics, grabX, grabY } = dragState;
  if (!metrics) {
    return;
  }

  const rect = img.getBoundingClientRect();
  const rawX = event.clientX - metrics.contentRect.left - grabX;
  const rawY = event.clientY - metrics.contentRect.top - grabY;
  const maxX = Math.max(0, metrics.innerWidth - rect.width);
  const maxY = Math.max(0, metrics.innerHeight - rect.height);
  const x = Math.min(Math.max(0, rawX), maxX);
  const y = Math.min(Math.max(0, rawY), maxY);

  placeImage(img, x, y, metrics.scale);
}

function handlePointerUp(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  const { img, id, active } = dragState;
  img.classList.remove("is-dragging");
  dragState = null;

  if (!active) {
    return;
  }

  const x = Number(img.dataset.freeX) || 0;
  const y = Number(img.dataset.freeY) || 0;

  replaceImageToken(id, (current) => buildImageToken(id, current.alt, current.widthMm, current.align, true, x, y));
  selectImage(id);
  renderAndPersist();
  setStatus(`图片已放到 x ${roundOne(x)}mm / y ${roundOne(y)}mm。`);
}

// 在 Markdown 里整行上下移动
function moveSelectedImage(direction) {
  if (!selectedImageId) {
    return;
  }

  const lines = els.markdown.value.split("\n");
  const current = lines.findIndex((line) => line.includes(`img:${selectedImageId}`));
  if (current < 0) {
    return;
  }

  let target = current + direction;
  while (target >= 0 && target < lines.length && !lines[target].trim()) {
    target += direction;
  }
  if (target < 0 || target >= lines.length) {
    return;
  }

  [lines[current], lines[target]] = [lines[target], lines[current]];
  els.markdown.value = lines.join("\n");
  renderAndPersist();
}

function removeSelectedImage() {
  if (!selectedImageId) {
    return;
  }

  const pattern = new RegExp(`!\\[[^\\]]*\\]\\(\\s*img:${selectedImageId}(?:\\s+"[^"]*")?\\s*\\)\\n?`, "g");
  els.markdown.value = els.markdown.value.replace(pattern, "");
  delete imageLibrary[selectedImageId];
  saveImageLibrary();
  selectedImageId = null;
  els.imageEditor.hidden = true;
  els.imageHint.textContent = "选一张本地图片，会插入到 Markdown 光标处。";
  renderImageList();
  renderAndPersist();
  setStatus("已删除图片。");
}

// 把图片插到 Markdown 光标处；没在编辑框里就把图片追加到末尾
function insertImageToken(id, name) {
  const alt = name || "图片";
  const widthMm = Number(els.imageWidth.value) || 80;
  const align = els.imageAlign.value || "center";
  const token = buildImageToken(id, alt, widthMm, align);
  const textarea = els.markdown;
  const length = textarea.value.length;
  const focused = document.activeElement === textarea;
  const start = focused ? (textarea.selectionStart ?? length) : length;
  const end = focused ? (textarea.selectionEnd ?? start) : length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const leading = before && !before.endsWith("\n") ? "\n" : "";
  const trailing = after && !after.startsWith("\n") ? "\n" : "";
  const caret = (before + leading + token).length;

  textarea.value = `${before}${leading}${token}${trailing}${after}`;
  textarea.selectionStart = caret;
  textarea.selectionEnd = caret;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

async function handleImageFile(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    const dataUrl = await imageFileToDataUrl(file, IMAGE_MAX_SIDE, 0.9);
    const id = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const name = file.name.replace(/\.[^.]+$/, "");

    imageLibrary[id] = { name, dataUrl };
    saveImageLibrary();
    insertImageToken(id, name);
    selectImage(id);
    setStatus(`已插入图片：${file.name}（可在右侧调宽度和位置）`);
  } catch (error) {
    setStatus(`插入图片失败：${error.message}`);
  } finally {
    event.target.value = "";
  }
}

// 点预览里的图片即可在面板里选中它
function handlePreviewClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLImageElement)) {
    return;
  }
  const id = target.dataset.imgId;
  if (id && imageLibrary[id]) {
    selectImage(id);
  }
}

function renderPreview() {
  els.preview.innerHTML = `<div class="resume-content">${renderMarkdown(els.markdown.value)}</div>`;
  renderPhoto();
  updatePhotoStatus();
  fitToOnePage();
  settleAllImages();
  document.fonts?.ready.then(fitToOnePage).catch(() => {});
}

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function getCurrentSettings() {
  return {
    marginX: Number(els.marginX.value),
    marginY: Number(els.marginY.value),
    baseFontSize: Number(els.baseFontSize.value),
    headingFontSize: Number(els.headingFontSize.value),
    nameFontSize: Number(els.nameFontSize.value),
    lineHeight: Number(els.lineHeight.value),
    paragraphGap: Number(els.paragraphGap.value),
    normalTextDepth: Number(els.normalTextDepth.value),
    fontFamily: els.fontFamily.value,
    photo: currentPhoto,
    photoWidth: Number(els.photoWidth.value),
  };
}

function applySettings(settings) {
  document.documentElement.style.setProperty("--page-margin-x", `${settings.marginX}px`);
  document.documentElement.style.setProperty("--page-margin-y", `${settings.marginY}px`);
  document.documentElement.style.setProperty("--base-font-size", `${settings.baseFontSize}px`);
  document.documentElement.style.setProperty("--heading-font-size", `${settings.headingFontSize}px`);
  document.documentElement.style.setProperty("--name-font-size", `${settings.nameFontSize}px`);
  document.documentElement.style.setProperty("--line-height", settings.lineHeight);
  document.documentElement.style.setProperty("--paragraph-gap", `${settings.paragraphGap}px`);
  document.documentElement.style.setProperty("--resume-font-family", settings.fontFamily);
  document.documentElement.style.setProperty("--normal-text-color", normalTextColor(settings.normalTextDepth));
  document.documentElement.style.setProperty("--photo-width", `${settings.photoWidth}mm`);

  outputs.marginX.textContent = `${settings.marginX}px`;
  outputs.marginY.textContent = `${settings.marginY}px`;
  outputs.baseFontSize.textContent = `${settings.baseFontSize}px`;
  outputs.headingFontSize.textContent = `${settings.headingFontSize}px`;
  outputs.nameFontSize.textContent = `${settings.nameFontSize}px`;
  outputs.lineHeight.textContent = settings.lineHeight.toFixed(2);
  outputs.paragraphGap.textContent = `${settings.paragraphGap}px`;
  outputs.normalTextDepth.textContent = `${settings.normalTextDepth}%`;
  outputs.photoWidth.textContent = `${settings.photoWidth}mm`;

  currentPhoto = settings.photo || "";
}

function syncControls(settings) {
  Object.entries(settings).forEach(([key, value]) => {
    if (els[key]) {
      els[key].value = value;
    }
  });
}

function loadMarkdown(markdown, status) {
  isLoadingMarkdown = true;
  els.markdown.value = markdown;
  renderPreview();
  setStatus(status);
  isLoadingMarkdown = false;
}

function loadInitialMarkdown() {
  loadMarkdown("", "请选择 Markdown 文件，选择后会自动双向同步。");
}

async function verifyFilePermission(handle, mode = "read") {
  if (!handle?.queryPermission) {
    return false;
  }

  const options = { mode };
  if ((await handle.queryPermission(options)) === "granted") {
    return true;
  }

  return (await handle.requestPermission(options)) === "granted";
}

async function readMarkdownFile() {
  const file = await markdownFileHandle.getFile();
  lastKnownFileModified = file.lastModified;
  return await file.text();
}

async function writeMarkdownFile() {
  if (!markdownFileHandle || isLoadingMarkdown) {
    return;
  }

  try {
    isWritingMarkdown = true;
    const writable = await markdownFileHandle.createWritable();
    await writable.write(els.markdown.value);
    await writable.close();

    const file = await markdownFileHandle.getFile();
    lastKnownFileModified = file.lastModified;
    hasPendingLocalSave = false;
    setStatus(`已自动保存到 ${markdownFileHandle.name}。外部修改也会自动刷新。`);
  } catch (error) {
    setStatus(`自动保存失败：${error.message}`);
  } finally {
    isWritingMarkdown = false;
  }
}

function scheduleMarkdownSave() {
  if (!markdownFileHandle || isLoadingMarkdown) {
    return;
  }

  hasPendingLocalSave = true;
  clearTimeout(pendingSaveTimer);
  setStatus(`正在等待保存到 ${markdownFileHandle.name}...`);
  pendingSaveTimer = window.setTimeout(writeMarkdownFile, 500);
}

async function pollMarkdownFile() {
  if (!markdownFileHandle || isLoadingMarkdown || isWritingMarkdown || hasPendingLocalSave) {
    return;
  }

  try {
    const file = await markdownFileHandle.getFile();
    if (file.lastModified === lastKnownFileModified) {
      return;
    }

    const markdown = await file.text();
    lastKnownFileModified = file.lastModified;
    loadMarkdown(markdown, `检测到 ${markdownFileHandle.name} 已在外部修改，已刷新。`);
  } catch (error) {
    setStatus(`检测文件变化失败：${error.message}`);
  }
}

async function openMarkdownFile() {
  if (!window.showOpenFilePicker) {
    setStatus("当前浏览器不支持自动写回文件，请使用新版 Chrome 或 Edge。");
    return;
  }

  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Markdown", accept: { "text/markdown": [".md", ".markdown"], "text/plain": [".txt"] } }],
      excludeAcceptAllOption: false,
      multiple: false,
    });

    if (!(await verifyFilePermission(handle, "readwrite"))) {
      setStatus("没有文件读写权限，无法自动双向同步。");
      return;
    }

    markdownFileHandle = handle;
    const markdown = await readMarkdownFile();
    loadMarkdown(markdown, `已绑定 ${handle.name}，网页修改会自动保存，外部修改会自动刷新。`);
  } catch (error) {
    if (error.name !== "AbortError") {
      setStatus(`选择失败：${error.message}`);
    }
  }
}

function renderAndPersist() {
  const settings = getCurrentSettings();
  renderPreview();
  applySettings(settings);
  fitToOnePage();
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  } catch (error) {
    setStatus(`设置保存失败（证件照可能过大）：${error.message}`);
  }
  scheduleMarkdownSave();
}

async function init() {
  const settings = readSettings();
  imageLibrary = readImageLibrary();

  syncControls(settings);
  applySettings(settings);
  renderPreview();
  loadInitialMarkdown();
  renderImageList();

  els.markdown.addEventListener("input", renderAndPersist);
  els.printBtn.addEventListener("click", handlePrint);
  els.openMdBtn.addEventListener("click", openMarkdownFile);
  els.choosePhotoBtn.addEventListener("click", () => els.photoFile.click());
  els.photoFile.addEventListener("change", handlePhotoFile);
  els.removePhotoBtn.addEventListener("click", removePhoto);
  els.addImageBtn.addEventListener("click", () => els.imageFile.click());
  els.imageFile.addEventListener("change", handleImageFile);
  els.imageWidth.addEventListener("input", applyImageSettings);
  els.imageAlign.addEventListener("change", applyImageSettings);
  els.imageFreeBtn.addEventListener("click", toggleFreeMode);
  els.imageMoveUp.addEventListener("click", () => moveSelectedImage(-1));
  els.imageMoveDown.addEventListener("click", () => moveSelectedImage(1));
  els.imageRemove.addEventListener("click", removeSelectedImage);
  els.preview.addEventListener("click", handlePreviewClick);
  els.preview.addEventListener("pointerdown", handlePreviewPointerDown);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerUp);

  ["marginX", "marginY", "baseFontSize", "headingFontSize", "nameFontSize", "lineHeight", "paragraphGap", "normalTextDepth", "fontFamily", "photoWidth"].forEach((key) => {
    els[key].addEventListener("input", renderAndPersist);
    els[key].addEventListener("change", renderAndPersist);
  });

  window.addEventListener("resize", fitToOnePage);
  window.setInterval(pollMarkdownFile, 1000);
}

init();
