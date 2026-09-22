/* =========================================================
   温泉データベース app.js
   目的：
   1) Supabase が設定されていれば Supabase に保存・読込
   2) Supabase 未設定でも、登録した温泉をこの端末に保存・一覧表示
   3) 保存失敗時も入力内容を失わないようにする
   ========================================================= */

(() => {
  "use strict";

  const TABLE_NAME = "onsen_database";
  const LOCAL_KEY = "onsen_database_local_v1";
  const DRAFT_KEY = "onsen_database_draft_v1";

  function getDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  function saveDraft(mode, editingIdValue) {
    try {
      const activeTabBtn = document.querySelector("#formTabBar .tab-btn.active");
      const draft = {
        mode,
        editingId: editingIdValue || null,
        data: collectFormData(),
        activeTab: activeTabBtn ? activeTabBtn.dataset.tabTarget : "basic",
        savedAt: new Date().toISOString()
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch (error) {
      console.error("下書きの保存に失敗:", error);
    }
  }

  function clearDraft() {
    localStorage.removeItem(DRAFT_KEY);
  }


  // ---------------------------------------------------------
  // Supabase設定
  // config.js があれば window.ONSEN_SUPABASE_CONFIG を使います。
  // まだ設定していない場合は空のままでOKです。
  // ---------------------------------------------------------
  const SUPABASE_URL =
    window.ONSEN_SUPABASE_CONFIG?.url || "";

  const SUPABASE_ANON_KEY =
    window.ONSEN_SUPABASE_CONFIG?.anonKey || "";

  let supabaseClient = null;
  let editingId = null;
  let currentUser = null;
  let myCurrentRating = 0;
  let highlightedFacilityId = null;
  let onsenAreasForMap = [];
  let lastMapItems = [];
  const AREA_CLUSTER_ZOOM_THRESHOLD = 13;
  let myFacilityStatusMap = {};
  let authMode = "login";

  function updateAuthHeaderUI(user) {
    const btn = $("openAuthButton");
    if (!btn) return;
    if (user) {
      btn.textContent = "🐥 マイページ";
    } else {
      btn.textContent = "👤 ログイン";
    }
  }

  function updateUserInfoLoginGate() {
    const banner = $("userInfoLoginBanner");
    const content = $("userInfoGatedContent");
    if (currentUser) {
      banner?.classList.add("hidden");
      content?.classList.remove("locked");
    } else {
      banner?.classList.remove("hidden");
      content?.classList.add("locked");
    }
  }

  async function refreshAuthState() {
    if (!supabaseClient) return null;
    const { data } = await supabaseClient.auth.getSession();
    const user = data?.session?.user || null;
    currentUser = user;
    updateAuthHeaderUI(user);
    updateUserInfoLoginGate();
    loadMyFacilityStatuses();
    return user;
  }

  function setAuthMode(mode) {
    authMode = mode;
    if (mode === "signup") {
      $("authModalTitle").textContent = "新規登録";
      $("authModalDesc").textContent = "メールアドレスとパスワードでアカウントを作成します。";
      $("authSubmit").textContent = "登録する";
      $("authToggleMode").textContent = "ログインはこちら";
      $("authToggleMode").previousSibling.textContent = "すでにアカウントをお持ちの方は";
    } else {
      $("authModalTitle").textContent = "ログイン";
      $("authModalDesc").textContent = "アカウントをお持ちの方はログインしてください。";
      $("authSubmit").textContent = "ログイン";
      $("authToggleMode").textContent = "新規登録はこちら";
      $("authToggleMode").previousSibling.textContent = "アカウントをお持ちでない方は";
    }
    $("authError")?.classList.add("hidden");
  }

  async function openAuthModal() {
    if (!supabaseClient) {
      alert("現在この機能は利用できません（Supabase未設定）。");
      return;
    }
    const user = await refreshAuthState();
    $("authModal")?.classList.remove("hidden");
    $("authModal")?.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");

    if (user) {
      $("authLoggedOutView")?.classList.add("hidden");
      $("authLoggedInView")?.classList.remove("hidden");
      $("authModalTitle").textContent = "アカウント";
      $("authModalDesc").textContent = "登録した情報を編集できます。";
      $("authCurrentEmail").textContent = user.email || "";
      setValue("authDisplayName", user.user_metadata?.display_name || "");
    } else {
      $("authLoggedOutView")?.classList.remove("hidden");
      $("authLoggedInView")?.classList.add("hidden");
      setAuthMode("login");
      setValue("authEmail", "");
      setValue("authPassword", "");
    }
  }

  function closeAuthModal() {
    $("authModal")?.classList.add("hidden");
    $("authModal")?.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  function renderMyRatingStars(rating) {
    const container = $("myRatingStars");
    if (!container) return;
    container.dataset.rating = String(rating || 0);
    container.querySelectorAll(".rating-star").forEach((star) => {
      star.classList.toggle("filled", Number(star.dataset.star) <= rating);
    });
  }

  async function loadMyRatingForOnsen(onsenId) {
    myCurrentRating = 0;
    renderMyRatingStars(0);
    setValue("myImpression", "");
    if (!supabaseClient || !currentUser || !onsenId) return;

    try {
      const { data, error } = await supabaseClient
        .from("ratings")
        .select("rating, impression")
        .eq("onsen_id", onsenId)
        .eq("user_id", currentUser.id)
        .maybeSingle();

      if (error) throw error;
      myCurrentRating = data?.rating || 0;
      renderMyRatingStars(myCurrentRating);
      setValue("myImpression", data?.impression || "");
    } catch (error) {
      console.error("評価の取得に失敗:", error);
    }
  }


  async function loadMyFacilityStatuses() {
    myFacilityStatusMap = {};
    if (!supabaseClient || !currentUser) return;

    try {
      const { data, error } = await supabaseClient
        .from("user_facility_status")
        .select("onsen_id, interested, visited")
        .eq("user_id", currentUser.id);
      if (error) throw error;

      (data || []).forEach((row) => {
        myFacilityStatusMap[row.onsen_id] = { interested: row.interested, visited: row.visited };
      });

      if (window.__onsenData) renderCardsWithData(window.__onsenData);
    } catch (error) {
      console.error("お気に入り状態の取得に失敗:", error);
    }
  }

  async function toggleFacilityFlag(onsenId, flagName) {
    if (!supabaseClient) return;
    if (!currentUser) {
      openAuthModal();
      return;
    }
    if (!onsenId) return;

    const current = myFacilityStatusMap[onsenId] || { interested: false, visited: false };
    const nextValue = !current[flagName];
    const nextStatus = { ...current, [flagName]: nextValue };

    try {
      const { error } = await supabaseClient.from("user_facility_status").upsert(
        {
          user_id: currentUser.id,
          onsen_id: onsenId,
          interested: !!nextStatus.interested,
          visited: !!nextStatus.visited,
          updated_at: new Date().toISOString()
        },
        { onConflict: "user_id,onsen_id" }
      );
      if (error) throw error;

      myFacilityStatusMap[onsenId] = nextStatus;
      if (window.__onsenData) renderCardsWithData(window.__onsenData);
      renderMyPageIfActive();
    } catch (error) {
      alert(`保存できませんでした：${error.message || "不明なエラー"}`);
    }
  }

  async function loadOnsenAreasForMap() {
    if (!supabaseClient) return;
    try {
      const { data, error } = await supabaseClient.from("onsen_areas").select("id, name, facility_ids");
      if (error) throw error;
      onsenAreasForMap = data || [];
      if (window.__onsenData) updateMap(getFilteredSortedList(window.__onsenData));
    } catch (error) {
      console.error("マップ用の温泉地データの取得に失敗:", error);
    }
  }

  async function loadRatingSummary() {
    if (!supabaseClient) return;
    try {
      const { data, error } = await supabaseClient.from("ratings").select("onsen_id, rating");
      if (error) throw error;

      const summary = {};
      (data || []).forEach((row) => {
        if (!summary[row.onsen_id]) summary[row.onsen_id] = { sum: 0, count: 0 };
        summary[row.onsen_id].sum += row.rating;
        summary[row.onsen_id].count += 1;
      });

      window.__ratingSummary = {};
      Object.keys(summary).forEach((id) => {
        window.__ratingSummary[id] = {
          average: summary[id].sum / summary[id].count,
          count: summary[id].count
        };
      });

      if (window.__onsenData) renderCardsWithData(window.__onsenData);
    } catch (error) {
      console.error("評価集計の取得に失敗:", error);
    }
  }

  async function submitMyRating(onsenId, rating) {
    if (!supabaseClient || !currentUser || !onsenId) return;

    try {
      const { error } = await supabaseClient
        .from("ratings")
        .upsert(
          { onsen_id: onsenId, user_id: currentUser.id, rating, updated_at: new Date().toISOString() },
          { onConflict: "onsen_id,user_id" }
        );
      if (error) throw error;
      myCurrentRating = rating;
      renderMyRatingStars(rating);
      loadRatingSummary();
    } catch (error) {
      alert(`評価を送信できませんでした：${error.message || "不明なエラー"}`);
    }
  }

  async function loadOnsenReviews(onsenId) {
    const container = $("onsenReviewsList");
    if (!container) return;
    if (!supabaseClient) {
      container.innerHTML = `<p class="detail-note-tight">まだ感想がありません。</p>`;
      return;
    }

    try {
      const { data, error } = await supabaseClient
        .from("ratings")
        .select("display_name, impression, created_at")
        .eq("onsen_id", onsenId)
        .not("impression", "is", null)
        .neq("impression", "")
        .order("created_at", { ascending: false });

      if (error) throw error;

      if (!data || !data.length) {
        container.innerHTML = `<p class="detail-note-tight">まだ感想がありません。</p>`;
        return;
      }

      container.innerHTML = data
        .map(
          (review, index) => `
            <div class="review-item">
              <p class="review-author">${escapeHtml(review.display_name || "名無しさん")}</p>
              <p class="review-body" id="reviewBody${index}">${escapeHtml(review.impression)}</p>
              <button type="button" class="link-button review-expand" data-target="reviewBody${index}">続きを見る</button>
            </div>
          `
        )
        .join("");

      container.querySelectorAll(".review-expand").forEach((btn) => {
        btn.addEventListener("click", () => {
          const body = $(btn.dataset.target);
          body?.classList.add("review-body-expanded");
          btn.classList.add("hidden");
        });
      });

      // 6行に収まる感想では「続きを見る」を隠す
      container.querySelectorAll(".review-body").forEach((body) => {
        if (body.scrollHeight <= body.clientHeight + 2) {
          const btn = container.querySelector(`[data-target="${body.id}"]`);
          btn?.classList.add("hidden");
        }
      });
    } catch (error) {
      console.error("感想の取得に失敗:", error);
      container.innerHTML = `<p class="detail-note-tight">感想を読み込めませんでした。</p>`;
    }
  }

  async function submitMyImpression(onsenId, impressionText) {
    if (!supabaseClient) return;
    if (!currentUser) {
      openAuthModal();
      return;
    }
    if (!onsenId) {
      alert("この施設を登録したあとに感想を書けます。");
      return;
    }

    try {
      const displayName = currentUser.user_metadata?.display_name || currentUser.email || "名無しさん";
      const { error } = await supabaseClient.from("ratings").upsert(
        {
          onsen_id: onsenId,
          user_id: currentUser.id,
          impression: impressionText,
          display_name: displayName,
          updated_at: new Date().toISOString()
        },
        { onConflict: "onsen_id,user_id" }
      );
      if (error) throw error;
      alert("感想を保存しました。");
    } catch (error) {
      alert(`感想を保存できませんでした：${error.message || "不明なエラー"}`);
    }
  }


  function initSupabase() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return null;
    }

    if (!window.supabase || !window.supabase.createClient) {
      console.warn("Supabaseライブラリが読み込まれていません。");
      return null;
    }

    try {
      return window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_ANON_KEY
      );
    } catch (error) {
      console.error("Supabase初期化エラー:", error);
      return null;
    }
  }

  supabaseClient = initSupabase();

  // ---------------------------------------------------------
  // 共通
  // ---------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  function value(id) {
    const el = $(id);
    return el ? el.value.trim() : "";
  }

  function numberValue(id) {
    const el = $(id);
    if (!el || el.value === "") return null;

    const n = Number(el.value);
    return Number.isFinite(n) ? n : null;
  }

  function checkedValues(name) {
    return [...document.querySelectorAll(`input[name="${name}"]:checked`)]
      .map((el) => el.value);
  }

  function radioValue(name) {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : "";
  }

  function checkedBool(id) {
    const el = $(id);
    return !!el?.checked;
  }

  function timeValue(prefix) {
    const hour = $(`${prefix}Hour`)?.value || "";
    const minute = $(`${prefix}Minute`)?.value || "";
    if (!hour || !minute) return "";
    return `${hour}:${minute}`;
  }

  function dateValue(prefix) {
    const year = $(`${prefix}Year`)?.value || "";
    const month = $(`${prefix}Month`)?.value || "";
    const day = $(`${prefix}Day`)?.value || "";
    if (!year) return "";
    const mm = month ? String(month).padStart(2, "0") : "";
    const dd = day ? String(day).padStart(2, "0") : "";
    return [year, mm, dd].filter(Boolean).join("-");
  }

  function setStatus(message, type = "") {
    const el = $("status");
    if (!el) return;

    el.textContent = message;
    el.className = `status ${type}`.trim();
  }

  function escapeHtml(text) {
    return String(text ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // 表示用：時刻の先頭0を除去（例："06:00" → "6:00"）。<input type="time"> の値設定には使わないこと。
  function ft(v) {
    if (v === null || v === undefined || v === "") return v;
    return String(v).replace(/^0(\d):/, "$1:");
  }

  // ---------------------------------------------------------
  // 市区町村・地域の選択肢を都道府県に応じて作る
  // ---------------------------------------------------------

  function populateAreaOptions(prefectureName, selectedValue) {
    const select = $("area");
    if (!select) return;

    const list = window.MUNICIPALITIES_BY_PREFECTURE?.[prefectureName] || [];

    select.innerHTML = "";

    if (!prefectureName) {
      select.innerHTML = '<option value="">先に都道府県を選択してください</option>';
      $("areaOtherWrap")?.classList.add("hidden");
      return;
    }

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "選択してください";
    select.appendChild(placeholder);

    list.forEach((name) => {
      const shortName = name.replace(/^.+郡/, "");
      const opt = document.createElement("option");
      opt.value = shortName;
      opt.textContent = shortName;
      select.appendChild(opt);
    });

    const otherOpt = document.createElement("option");
    otherOpt.value = "その他";
    otherOpt.textContent = "その他（一覧にない場合）";
    select.appendChild(otherOpt);

    if (selectedValue && list.includes(selectedValue)) {
      select.value = selectedValue;
      $("areaOtherWrap")?.classList.add("hidden");
    } else if (selectedValue) {
      // 一覧に無い値（旧データ・自由記述など）は「その他」にして元の値を残す
      select.value = "その他";
      $("areaOtherWrap")?.classList.remove("hidden");
      setValue("areaOther", selectedValue);
    } else {
      $("areaOtherWrap")?.classList.add("hidden");
    }
  }

  // ---------------------------------------------------------
  // レンタル品
  // #rentalRows に行を動的に追加・削除できるようにする
  // ---------------------------------------------------------

  let rentalRowSeq = 0;

  function addRentalRow(containerId, name = "", price = "", { focus = true } = {}) {
    const rows = $(containerId);
    if (!rows) return;

    const rowId = `rental-${++rentalRowSeq}`;
    const row = document.createElement("div");
    row.className = "rental-row";
    row.dataset.rowId = rowId;

    row.innerHTML = `
      <input type="text" class="rental-name" name="rental-name-${rowId}" autocomplete="off" placeholder="例：タオル" maxlength="60" value="${escapeHtml(name)}">
      <input type="number" class="rental-price" name="rental-price-${rowId}" autocomplete="off" placeholder="料金（円）" min="0" value="${escapeHtml(price)}">
      <button type="button" class="remove-rental" aria-label="このレンタル品を削除">×</button>
    `;

    rows.appendChild(row);
    if (focus) {
      row.querySelector(".rental-name")?.focus();
    }
  }

  function collectRentalItems(containerId) {
    const rows = $(containerId);
    if (!rows) return [];

    const result = [];

    rows.querySelectorAll(".rental-row").forEach((row) => {
      const name = row.querySelector(".rental-name")?.value.trim() || "";
      const price = row.querySelector(".rental-price")?.value.trim() || "";

      if (!name && !price) return;

      result.push(price ? `${name || "レンタル品"}（${price}円）` : name);
    });

    return result;
  }

  // ---------------------------------------------------------
  // 料金（入浴料・その他料金区分）
  // 「区分」「料金」を動的に追加・削除できる汎用の行システム
  // ---------------------------------------------------------

  let feeRowSeq = 0;

  function addFeeRow(containerId, category = "", amount = "", { focus = true } = {}) {
    const rows = $(containerId);
    if (!rows) return;

    const rowId = `fee-${++feeRowSeq}`;
    const row = document.createElement("div");
    row.className = "rental-row";
    row.dataset.rowId = rowId;

    row.innerHTML = `
      <input type="text" class="fee-category" name="fee-category-${rowId}" autocomplete="off" placeholder="区分（例：大人）" maxlength="40" value="${escapeHtml(category)}">
      <input type="number" class="fee-amount" name="fee-amount-${rowId}" autocomplete="off" placeholder="料金（円）" min="0" value="${escapeHtml(amount)}">
      <button type="button" class="remove-rental" aria-label="この項目を削除">×</button>
    `;

    rows.appendChild(row);
    if (focus) {
      row.querySelector(".fee-category")?.focus();
    }
  }

  function addMenuFeeRow(containerId, menu = "", minutes = "", price = "", { focus = true } = {}) {
    const rows = $(containerId);
    if (!rows) return;

    const rowId = `menu-fee-${++feeRowSeq}`;
    const row = document.createElement("div");
    row.className = "menu-fee-row";
    row.dataset.rowId = rowId;

    row.innerHTML = `
      <input type="text" class="menu-fee-name" name="menu-fee-name-${rowId}" autocomplete="off" placeholder="メニュー（例：もみほぐし）" maxlength="60" value="${escapeHtml(menu)}">
      <input type="number" class="menu-fee-minutes" name="menu-fee-minutes-${rowId}" autocomplete="off" placeholder="分" min="0" value="${escapeHtml(minutes)}">
      <input type="number" class="menu-fee-price" name="menu-fee-price-${rowId}" autocomplete="off" placeholder="円" min="0" value="${escapeHtml(price)}">
      <button type="button" class="remove-rental" aria-label="このメニューを削除">×</button>
    `;

    rows.appendChild(row);
    if (focus) {
      row.querySelector(".menu-fee-name")?.focus();
    }
  }

  function collectMenuFeeRows(containerId) {
    const rows = $(containerId);
    if (!rows) return [];

    const result = [];
    rows.querySelectorAll(".menu-fee-row").forEach((row) => {
      const menu = row.querySelector(".menu-fee-name")?.value.trim() || "";
      const minutes = row.querySelector(".menu-fee-minutes")?.value.trim() || "";
      const price = row.querySelector(".menu-fee-price")?.value.trim() || "";

      if (!menu && !minutes && !price) return;

      result.push({
        menu: menu || "メニュー",
        minutes: minutes ? Number(minutes) : null,
        price: price ? Number(price) : null
      });
    });

    return result;
  }

  function populateMenuFeeRows(containerId, items) {
    const rows = $(containerId);
    if (!rows) return;
    rows.innerHTML = "";
    if (!Array.isArray(items) || !items.length) return;

    items.forEach((it) =>
      addMenuFeeRow(containerId, it.menu || "", it.minutes ?? "", it.price ?? "", { focus: false })
    );
  }

  function collectFeeRows(containerId) {
    const rows = $(containerId);
    if (!rows) return [];

    const result = [];

    rows.querySelectorAll(".rental-row").forEach((row) => {
      const category = row.querySelector(".fee-category")?.value.trim() || "";
      const amount = row.querySelector(".fee-amount")?.value.trim() || "";

      // 料金が未入力の行は保存しない（区分だけの空行を除外）
      if (!amount) return;

      result.push({ category: category || "料金", amount: Number(amount) });
    });

    return result;
  }

  // メニュー名・時間（分）・料金（円）の3項目版（マッサージ等の料金表用）
  let feeRow3Seq = 0;

  function addFeeRow3(containerId, name = "", minutes = "", price = "", { focus = true } = {}) {
    const rows = $(containerId);
    if (!rows) return;

    const rowId = `fee3-${++feeRow3Seq}`;
    const row = document.createElement("div");
    row.className = "rental-row rental-row-3";
    row.dataset.rowId = rowId;

    row.innerHTML = `
      <input type="text" class="fee3-name" name="fee3-name-${rowId}" autocomplete="off" placeholder="メニュー（例：全身マッサージ）" maxlength="60" value="${escapeHtml(name)}">
      <input type="number" class="fee3-minutes" name="fee3-minutes-${rowId}" autocomplete="off" placeholder="分" min="0" value="${escapeHtml(minutes)}">
      <input type="number" class="fee3-price" name="fee3-price-${rowId}" autocomplete="off" placeholder="円" min="0" value="${escapeHtml(price)}">
      <button type="button" class="remove-rental" aria-label="この項目を削除">×</button>
    `;

    rows.appendChild(row);
    if (focus) {
      row.querySelector(".fee3-name")?.focus();
    }
  }

  function collectFeeRows3(containerId) {
    const rows = $(containerId);
    if (!rows) return [];

    const result = [];

    rows.querySelectorAll(".rental-row-3").forEach((row) => {
      const name = row.querySelector(".fee3-name")?.value.trim() || "";
      const minutes = row.querySelector(".fee3-minutes")?.value.trim() || "";
      const price = row.querySelector(".fee3-price")?.value.trim() || "";

      if (!name && !minutes && !price) return;

      result.push({
        name: name || "メニュー",
        minutes: minutes ? Number(minutes) : null,
        price: price ? Number(price) : null
      });
    });

    return result;
  }

  // 回数券（区分・枚つづり・円の3項目）
  let ticketRowSeq = 0;

  function addTicketFeeRow(containerId, category = "", sheets = "", price = "", { focus = true } = {}) {
    const rows = $(containerId);
    if (!rows) return;

    const rowId = `ticket-${++ticketRowSeq}`;
    const row = document.createElement("div");
    row.className = "rental-row rental-row-3";
    row.dataset.rowId = rowId;

    row.innerHTML = `
      <input type="text" class="ticket-category" name="ticket-category-${rowId}" autocomplete="off" placeholder="区分（例：大人）" maxlength="40" value="${escapeHtml(category)}">
      <input type="number" class="ticket-sheets" name="ticket-sheets-${rowId}" autocomplete="off" placeholder="枚つづり" min="0" value="${escapeHtml(sheets)}">
      <input type="number" class="ticket-price" name="ticket-price-${rowId}" autocomplete="off" placeholder="円" min="0" value="${escapeHtml(price)}">
      <button type="button" class="remove-rental" aria-label="この項目を削除">×</button>
    `;

    rows.appendChild(row);
    if (focus) {
      row.querySelector(".ticket-category")?.focus();
    }
  }

  function collectTicketFeeRows(containerId) {
    const rows = $(containerId);
    if (!rows) return [];

    const result = [];
    rows.querySelectorAll(".rental-row-3").forEach((row) => {
      const category = row.querySelector(".ticket-category")?.value.trim() || "";
      const sheets = row.querySelector(".ticket-sheets")?.value.trim() || "";
      const price = row.querySelector(".ticket-price")?.value.trim() || "";

      if (!category && !sheets && !price) return;

      result.push({
        category: category || "回数券",
        sheets: sheets ? Number(sheets) : null,
        price: price ? Number(price) : null
      });
    });

    return result;
  }

  function populateTicketFeeRows(containerId, items) {
    const rows = $(containerId);
    if (!rows) return;
    rows.innerHTML = "";
    if (!Array.isArray(items) || !items.length) return;
    items.forEach((it) =>
      addTicketFeeRow(containerId, it.category || "", it.sheets ?? "", it.price ?? "", { focus: false })
    );
  }

  // 会員優待・優待券（対象サービス名・優待内容の2項目）
  let benefitRowSeq = 0;

  // 追加の営業時間帯（開始・終了のペアを複数登録できる）
  let hoursRangeRowSeq = 0;

  function buildHourOptions() {
    let html = '<option value="">--</option>';
    for (let h = 0; h < 24; h++) {
      const v = String(h).padStart(2, "0");
      html += `<option value="${v}">${v}</option>`;
    }
    return html;
  }

  function buildMinuteOptions() {
    let html = '<option value="">--</option>';
    for (let m = 0; m < 60; m += 10) {
      const v = String(m).padStart(2, "0");
      html += `<option value="${v}">${v}</option>`;
    }
    return html;
  }

  const HOURS_ROW_DAY_OPTIONS = ["日", "月", "火", "水", "木", "金", "土", "祝"];

  function addHoursRangeRow(
    containerId,
    open = "",
    close = "",
    { focus = true, lastEntry = null, withLastEntry = false, withDays = false, days = [] } = {}
  ) {
    const rows = $(containerId);
    if (!rows) return;

    const rowId = `hoursrange-${++hoursRangeRowSeq}`;
    const [openH = "", openM = ""] = (open || "").split(":");
    const [closeH = "", closeM = ""] = (close || "").split(":");
    const [lastH = "", lastM = ""] = (lastEntry || "").split(":");
    const hourOptions = buildHourOptions();
    const minuteOptions = buildMinuteOptions();

    const row = document.createElement("div");
    row.className = withLastEntry ? "rental-row hours-range-row with-last-entry" : "rental-row hours-range-row";
    if (withDays) row.classList.add("with-days");
    row.dataset.rowId = rowId;
    row.innerHTML = `
      ${
        withDays
          ? `<div class="hours-row-days checks">${HOURS_ROW_DAY_OPTIONS.map(
              (d) =>
                `<label><input type="checkbox" class="hours-row-day" value="${d}" ${
                  Array.isArray(days) && days.includes(d) ? "checked" : ""
                }>${d}${d === "祝" ? "" : "曜"}</label>`
            ).join("")}</div>`
          : ""
      }
      <div class="hours-time-line">
        <div class="time-select"><select class="hours-open-hour">${hourOptions}</select><span>:</span><select class="hours-open-minute">${minuteOptions}</select></div>
        <span>〜</span>
        <div class="time-select"><select class="hours-close-hour">${hourOptions}</select><span>:</span><select class="hours-close-minute">${minuteOptions}</select></div>
        ${
          withLastEntry
            ? `<span class="hours-last-entry-label">最終受付</span><div class="time-select"><select class="hours-last-entry-hour">${hourOptions}</select><span>:</span><select class="hours-last-entry-minute">${minuteOptions}</select></div>`
            : ""
        }
        <button type="button" class="remove-rental" aria-label="この時間帯を削除">×</button>
      </div>
    `;
    rows.appendChild(row);

    if (openH) row.querySelector(".hours-open-hour").value = openH;
    if (openM) row.querySelector(".hours-open-minute").value = openM;
    if (closeH) row.querySelector(".hours-close-hour").value = closeH;
    if (closeM) row.querySelector(".hours-close-minute").value = closeM;
    if (withLastEntry) {
      if (lastH) row.querySelector(".hours-last-entry-hour").value = lastH;
      if (lastM) row.querySelector(".hours-last-entry-minute").value = lastM;
    }

    if (focus) row.querySelector(".hours-open-hour")?.focus();
  }

  function collectHoursRangeRows(containerId, { withLastEntry = false, withDays = false } = {}) {
    const rows = $(containerId);
    if (!rows) return [];

    const result = [];
    rows.querySelectorAll(".hours-range-row").forEach((row) => {
      const oh = row.querySelector(".hours-open-hour")?.value || "";
      const om = row.querySelector(".hours-open-minute")?.value || "";
      const ch = row.querySelector(".hours-close-hour")?.value || "";
      const cm = row.querySelector(".hours-close-minute")?.value || "";
      const open = oh && om ? `${oh}:${om}` : "";
      const close = ch && cm ? `${ch}:${cm}` : "";
      let lastEntry = "";
      if (withLastEntry) {
        const lh = row.querySelector(".hours-last-entry-hour")?.value || "";
        const lm = row.querySelector(".hours-last-entry-minute")?.value || "";
        lastEntry = lh && lm ? `${lh}:${lm}` : "";
      }
      let rowDays = [];
      if (withDays) {
        rowDays = Array.from(row.querySelectorAll(".hours-row-day:checked")).map((el) => el.value);
      }
      if (!open && !close && !lastEntry) return;
      const entry = { open, close };
      if (withLastEntry) entry.lastEntry = lastEntry;
      if (withDays) entry.days = rowDays;
      result.push(entry);
    });

    return result;
  }

  function populateHoursRangeRows(containerId, items, { withLastEntry = false, withDays = false } = {}) {
    const rows = $(containerId);
    if (!rows) return;
    rows.innerHTML = "";
    if (!Array.isArray(items) || !items.length) return;
    items.forEach((it) =>
      addHoursRangeRow(containerId, it.open || "", it.close || "", {
        focus: false,
        lastEntry: it.lastEntry || "",
        withLastEntry,
        withDays,
        days: it.days || []
      })
    );
  }

  function addBenefitRow(containerId, service = "", content = "", { focus = true } = {}) {
    const rows = $(containerId);
    if (!rows) return;

    const rowId = `benefit-${++benefitRowSeq}`;
    const row = document.createElement("div");
    row.className = "rental-row";
    row.dataset.rowId = rowId;

    row.innerHTML = `
      <input type="text" class="benefit-service" name="benefit-service-${rowId}" autocomplete="off" placeholder="対象サービス名" maxlength="60" value="${escapeHtml(service)}">
      <input type="text" class="benefit-content" name="benefit-content-${rowId}" autocomplete="off" placeholder="優待内容" maxlength="100" value="${escapeHtml(content)}">
      <button type="button" class="remove-rental" aria-label="この項目を削除">×</button>
    `;

    rows.appendChild(row);
    if (focus) {
      row.querySelector(".benefit-service")?.focus();
    }
  }

  function collectBenefitRows(containerId) {
    const rows = $(containerId);
    if (!rows) return [];

    const result = [];
    rows.querySelectorAll(".rental-row").forEach((row) => {
      const service = row.querySelector(".benefit-service")?.value.trim() || "";
      const content = row.querySelector(".benefit-content")?.value.trim() || "";
      if (!service && !content) return;
      result.push({ service, content });
    });

    return result;
  }

  function populateBenefitRows(containerId, items) {
    const rows = $(containerId);
    if (!rows) return;
    rows.innerHTML = "";
    if (!Array.isArray(items) || !items.length) return;
    items.forEach((it) => addBenefitRow(containerId, it.service || "", it.content || "", { focus: false }));
  }

  const DEFAULT_BATH_FEE_CATEGORIES = [
    "大人",
    "子ども",
    "小学生",
    "幼児",
    "乳幼児",
    "シニア",
    "障がい者",
    "介助者",
    "その他の料金対象"
  ];

  const DEFAULT_OTHER_FEE_CATEGORIES = [
    "貸切風呂",
    "家族風呂",
    "サウナ",
    "岩盤浴",
    "休憩施設",
    "会員料",
    "その他料金区分"
  ];

  // ---------------------------------------------------------
  // フォーム → 保存データ
  // ---------------------------------------------------------

  function collectFormData() {
    return {
      name: value("name"),
      prefecture: value("prefecture"),
      area: value("area") === "その他" ? value("areaOther") : value("area"),
      address: value("address"),
      business_type:
        value("businessType") === "その他" && value("businessTypeOther")
          ? value("businessTypeOther")
          : value("businessType"),
      phone: value("phone"),
      spring_type:
        radioValue("springType") === "その他" && value("springTypeOther")
          ? value("springTypeOther")
          : radioValue("springType"),
      source_type:
        radioValue("sourceType") === "その他" && value("sourceTypeOther")
          ? value("sourceTypeOther")
          : radioValue("sourceType"),
      nearest_station: value("nearestStation"),
      access_method: value("accessMethod"),

      is_24_hours: checkedBool("is24Hours"),
      open_time: timeValue("openTime"),
      close_time: timeValue("closeTime"),
      last_entry: timeValue("lastEntry"),
      closed_days: checkedValues("closedDay"),
      overnight_open_time: timeValue("overnightOpen"),
      overnight_close_time: timeValue("overnightClose"),
      overnight_last_entry: timeValue("overnightLastEntry"),
      overnight_days: checkedValues("overnightDays"),
      overnight_additional_hours: collectHoursRangeRows("overnightAdditionalHoursRows", { withLastEntry: true, withDays: true }),
      morning_bath_open_time: timeValue("morningBathOpen"),
      morning_bath_close_time: timeValue("morningBathClose"),
      morning_bath_last_entry: timeValue("morningBathLastEntry"),
      morning_bath_days: checkedValues("morningBathDays"),
      morning_bath_additional_hours: collectHoursRangeRows("morningBathAdditionalHoursRows", { withLastEntry: true, withDays: true }),
      other_hours_label: value("otherHoursLabel"),
      other_hours_open_time: timeValue("otherHoursOpen"),
      other_hours_close_time: timeValue("otherHoursClose"),
      other_hours_last_entry: timeValue("otherHoursLastEntry"),
      other_hours_days: checkedValues("otherHoursDays"),
      other_hours_additional_hours: collectHoursRangeRows("otherHoursAdditionalHoursRows", { withLastEntry: true, withDays: true }),
      closed_nth_weeks: checkedBool("closedNthWeekdayEnabled")
        ? checkedValues("closedNthWeek")
        : null,
      closed_nth_weekday: checkedBool("closedNthWeekdayEnabled") ? value("closedNthWeekday") : null,
      closed_monthly_dates: checkedBool("closedMonthlyDatesEnabled") ? value("closedMonthlyDates") : null,
      closed_irregular: checkedBool("closedIrregular"),
      closed_calendar_based: checkedBool("closedCalendarBased"),
      closed_holiday_rule: radioValue("closedHolidayRule") || null,
      closed_day_pattern_note: value("closedDayPatternNote"),
      closed_days_note: value("closedDaysNote"),
      is_temp_closed: checkedBool("tempClosed"),
      temp_closed_detail: value("tempClosedDetail"),
      is_closed: checkedBool("closedPermanently"),
      weekday_hours_overrides: (() => {
        const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat", "holiday"];
        const dayChars = { sun: "日", mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", holiday: "祝" };
        const result = {};
        days.forEach((code) => {
          if (!checkedBool(`weekdayHoursEnabled_${code}`)) return;
          const open = timeValue(`weekdayHoursOpen_${code}`);
          const close = timeValue(`weekdayHoursClose_${code}`);
          const lastEntry = timeValue(`weekdayHoursLastEntry_${code}`);
          if (open || close || lastEntry) {
            result[dayChars[code]] = { open: open || null, close: close || null, lastEntry: lastEntry || null };
          }
        });
        return Object.keys(result).length ? result : null;
      })(),
      hours_note: value("hoursNote"),

      usage: [
        ...checkedValues("usage"),
        ...(checkedBool("usageOtherCheck")
          ? [value("usageOther") || "その他"]
          : [])
      ],

      bath_fees: collectFeeRows("bathFeeRows"),
      ticket_fees: collectTicketFeeRows("ticketFeeRows"),
      disability_fees: collectFeeRows("disabilityFeeRows"),
      disability_fee_note: value("disabilityFeeNote"),
      member_benefits: collectBenefitRows("memberBenefitRows"),
      special_coupons: collectBenefitRows("specialCouponRows"),
      discount_supplementary_note: value("discountSupplementaryNote"),
      other_fees: collectFeeRows("otherFeeRows"),
      purchase_method: [
        ...checkedValues("purchaseMethod"),
        ...(checkedBool("purchaseMethodOtherCheck")
          ? [value("purchaseMethodOther") || "その他"]
          : [])
      ],
      payment: [
        ...checkedValues("payment"),
        ...(checkedBool("paymentOtherCheck")
          ? [value("paymentOther") || "その他"]
          : [])
      ],
      point_card: radioValue("pointCard"),
      membership_card: radioValue("membershipCard"),
      wristband_payment: radioValue("wristbandPayment"),
      price_note: value("priceNote"),

      website: value("website"),
      instagram: value("instagram"),
      twitter: value("twitter"),
      facebook: value("facebook"),

      bath_shape_male: [
        ...checkedValues("maleBathShape"),
        ...(checkedBool("maleBathShapeOtherCheck")
          ? [value("maleBathShapeOther") || "その他の形状"]
          : [])
      ],
      bath_function_male: [
        ...checkedValues("maleBathFunction"),
        ...(checkedBool("maleBathFunctionOtherCheck")
          ? [value("maleBathFunctionOther") || "その他の機能・種類"]
          : [])
      ],
      private_bath_duration_male: numberValue("malePrivateBathDuration"),
      private_bath_capacity_status_male: radioValue("malePrivateBathCapacityStatus"),
      private_bath_capacity_male: numberValue("malePrivateBathCapacity"),
      private_bath_note_male: value("malePrivateBathNote"),
      bath_location_male: [
        ...checkedValues("maleBathLocation"),
        ...(checkedBool("maleBathLocationOtherCheck")
          ? [value("maleBathLocationOther") || "その他"]
          : [])
      ],
      bath_handrail_male: radioValue("maleBathHandrail"),
      toiletry_shelf_male: radioValue("maleToiletryShelf"),
      bath_anteroom_male: radioValue("maleBathAnteroom"),
      bath_event_male: radioValue("maleBathEvent"),
      bath_event_detail_male: value("maleBathEventDetail"),
      bath_toys_male: radioValue("maleBathToys"),
      bath_toys_detail_male: value("maleBathToysDetail"),
      bath_note_male: value("maleBathNote"),

      bath_shape_female: [
        ...checkedValues("femaleBathShape"),
        ...(checkedBool("femaleBathShapeOtherCheck")
          ? [value("femaleBathShapeOther") || "その他の形状"]
          : [])
      ],
      bath_function_female: [
        ...checkedValues("femaleBathFunction"),
        ...(checkedBool("femaleBathFunctionOtherCheck")
          ? [value("femaleBathFunctionOther") || "その他の機能・種類"]
          : [])
      ],
      private_bath_duration_female: numberValue("femalePrivateBathDuration"),
      private_bath_capacity_status_female: radioValue("femalePrivateBathCapacityStatus"),
      private_bath_capacity_female: numberValue("femalePrivateBathCapacity"),
      private_bath_note_female: value("femalePrivateBathNote"),
      bath_location_female: [
        ...checkedValues("femaleBathLocation"),
        ...(checkedBool("femaleBathLocationOtherCheck")
          ? [value("femaleBathLocationOther") || "その他"]
          : [])
      ],
      bath_handrail_female: radioValue("femaleBathHandrail"),
      toiletry_shelf_female: radioValue("femaleToiletryShelf"),
      bath_anteroom_female: radioValue("femaleBathAnteroom"),
      bath_event_female: radioValue("femaleBathEvent"),
      bath_event_detail_female: value("femaleBathEventDetail"),
      bath_toys_female: radioValue("femaleBathToys"),
      bath_toys_detail_female: value("femaleBathToysDetail"),
      bath_note_female: value("femaleBathNote"),

      // ♨️ 温泉情報
      spring_types: [
        ...checkedValues("springTypes"),
        ...(checkedBool("springTypeOtherCheck")
          ? [value("springTypeOther") || "その他の泉質"]
          : [])
      ],
      indications: [
        ...checkedValues("indications"),
        ...(value("indicationsOther") ? [value("indicationsOther")] : [])
      ],
      spring_color: [
        ...checkedValues("springColor"),
        ...(checkedBool("springColorOtherCheck")
          ? [value("springColorOther") || "その他の色"]
          : [])
      ],
      spring_smell: [
        ...checkedValues("springSmell"),
        ...(checkedBool("springSmellOtherCheck")
          ? [value("springSmellOther") || "その他の匂い"]
          : [])
      ],
      spring_texture: [
        ...checkedValues("springTexture"),
        ...(checkedBool("springTextureOtherCheck")
          ? [value("springTextureOther") || "その他"]
          : [])
      ],
      source_free_flow: radioValue("sourceFreeFlow"),
      spring_dilution: radioValue("springDilution"),
      spring_heating: radioValue("springHeating"),
      spring_circulation: radioValue("springCirculation"),
      spring_disinfection: radioValue("springDisinfection"),
      spring_usage_note: value("springUsageNote"),
      spring_temperature: numberValue("springTemperature"),
      source_temperature: numberValue("sourceTemperature"),
      spring_ph: numberValue("springPh"),
      spring_source_name: value("springSourceName"),
      spring_open_year: numberValue("springOpenYear"),
      spring_open_year_note: value("springOpenYearNote"),
      spring_analysis: radioValue("springAnalysis"),
      spring_analysis_date: dateValue("springAnalysis"),
      legionella_test: radioValue("legionellaTest"),
      legionella_test_date: dateValue("legionella"),
      legionella_result: radioValue("legionellaResult"),
      spring_info_source: [
        ...checkedValues("springInfoSource"),
        ...(checkedBool("springInfoSourceOtherCheck")
          ? [value("springInfoSourceOther") || "その他"]
          : [])
      ],
      spring_info_check_date: dateValue("springInfoCheck"),
      child_mixed_bathing: radioValue("childMixedBathing"),
      child_age_limit: radioValue("childAgeLimit"),
      child_gender_limit: radioValue("childGenderLimit"),
      child_boy_age_limit: numberValue("childBoyAgeLimit"),
      child_girl_age_limit: numberValue("childGirlAgeLimit"),
      child_mixed_bathing_note: value("childMixedBathingNote"),
      child_info_source: [
        ...checkedValues("childInfoSource"),
        ...(checkedBool("childInfoSourceOtherCheck")
          ? [value("childInfoSourceOther") || "その他"]
          : [])
      ],
      child_info_check_date: dateValue("childInfoCheck"),

      // 🧖‍♀️ サウナ関連
      sauna_facility_male: radioValue("maleSaunaFacility"),
      sauna_facility_suspended_male: checkedBool("maleSaunaFacilitySuspended"),
      sauna_facility_location_male:
        radioValue("maleSaunaFacilityLocation") === "その他" && value("maleSaunaFacilityLocationOther")
          ? value("maleSaunaFacilityLocationOther")
          : radioValue("maleSaunaFacilityLocation"),
      sauna_hours_type_male: radioValue("maleSaunaHoursType"),
      sauna_hours_weekday_open_male: timeValue("saunaHoursWeekdayOpen"),
      sauna_hours_weekday_close_male: timeValue("saunaHoursWeekdayClose"),
      sauna_hours_saturday_open_male: timeValue("saunaHoursSaturdayOpen"),
      sauna_hours_saturday_close_male: timeValue("saunaHoursSaturdayClose"),
      sauna_hours_sunday_open_male: timeValue("saunaHoursSundayOpen"),
      sauna_hours_sunday_close_male: timeValue("saunaHoursSundayClose"),
      sauna_hours_holiday_open_male: timeValue("saunaHoursHolidayOpen"),
      sauna_hours_holiday_close_male: timeValue("saunaHoursHolidayClose"),
      sauna_types_male: [
        ...checkedValues("maleSaunaTypes"),
        ...(checkedBool("maleSaunaTypesOtherCheck")
          ? [value("maleSaunaTypesOther") || "その他"]
          : [])
      ],
      sauna_temp_min_male: numberValue("maleSaunaTempMin"),
      sauna_temp_max_male: numberValue("maleSaunaTempMax"),
      sauna_humidity_min_male: numberValue("maleSaunaHumidityMin"),
      sauna_humidity_max_male: numberValue("maleSaunaHumidityMax"),
      sauna_capacity_number_male: numberValue("maleSaunaCapacityNumber"),
      sauna_capacity_range_male: value("maleSaunaCapacityRange"),
      sauna_thermometer_male: radioValue("maleSaunaThermometer"),
      sauna_clock_male: radioValue("maleSaunaClock"),
      sauna_twelve_min_timer_male: radioValue("maleSaunaTwelveMinTimer"),
      sauna_hourglass_male: radioValue("maleSaunaHourglass"),
      sauna_tv_male: radioValue("maleSaunaTv"),
      sauna_tv_remote_male: radioValue("maleSaunaTvRemote"),
      sauna_emergency_button_male: radioValue("maleSaunaEmergencyButton"),
      sauna_stones_male: radioValue("maleSaunaStones"),
      sauna_stove_type_male:
        radioValue("maleSaunaStoveType") === "その他" && value("maleSaunaStoveTypeOther")
          ? value("maleSaunaStoveTypeOther")
          : radioValue("maleSaunaStoveType"),
      sauna_stove_count_status_male: radioValue("maleSaunaStoveCountStatus"),
      sauna_stove_count_male: numberValue("maleSaunaStoveCount"),
      sauna_stove_brand_male: value("maleSaunaStoveBrand"),
      sauna_mat_rental_male: radioValue("maleSaunaMatRental"),
      sauna_mat_type_male: [
        ...checkedValues("maleSaunaMatType"),
        ...(checkedBool("maleSaunaMatTypeOtherCheck")
          ? [value("maleSaunaMatTypeOther") || "その他"]
          : [])
      ],
      sauna_mat_placement_male: [
        ...checkedValues("maleSaunaMatPlacement"),
        ...(checkedBool("maleSaunaMatPlacementOtherCheck")
          ? [value("maleSaunaMatPlacementOther") || "その他"]
          : [])
      ],
      sauna_goods_rental_male: radioValue("maleSaunaGoodsRental"),
      sauna_goods_sale_male: radioValue("maleSaunaGoodsSale"),
      sauna_loyly_male: radioValue("maleSaunaLoyly"),
      sauna_loyly_type_male: [
        ...checkedValues("maleSaunaLoylyType"),
        ...(checkedBool("maleSaunaLoylyTypeOtherCheck")
          ? [value("maleSaunaLoylyTypeOther") || "その他"]
          : [])
      ],
      sauna_aroma_loyly_male: radioValue("maleSaunaAromaLoyly"),
      sauna_aroma_type_male: value("maleSaunaAromaType"),
      sauna_aufguss_male: radioValue("maleSaunaAufguss"),
      sauna_loyly_frequency_male: radioValue("maleSaunaLoylyFrequency"),
      sauna_loyly_interval_minutes_male: numberValue("maleSaunaLoylyIntervalMinutes"),
      sauna_loyly_interval_note_male: value("maleSaunaLoylyIntervalNote"),
      sauna_loyly_reservation_male: radioValue("maleSaunaLoylyReservation"),
      sauna_loyly_note_male: value("maleSaunaLoylyNote"),
      sauna_door_type_male:
        radioValue("maleSaunaDoorType") === "その他" && value("maleSaunaDoorTypeOther")
          ? value("maleSaunaDoorTypeOther")
          : radioValue("maleSaunaDoorType"),
      sauna_exit_direction_male: radioValue("maleSaunaExitDirection"),
      sauna_light_brightness_male: radioValue("maleSaunaLightBrightness"),
      sauna_room_note_male: value("maleSaunaRoomNote"),

      cold_bath_availability_male: radioValue("maleColdBathAvailability"),
      cold_bath_count_male: numberValue("maleColdBathCount"),
      cold_bath_shape_male: checkedValues("maleColdBathShape"),
      cold_bath_location_male: checkedValues("maleColdBathLocation"),
      cold_bath_source_male: [
        ...checkedValues("maleColdBathSource"),
        ...(checkedBool("maleColdBathSourceOtherCheck")
          ? [value("maleColdBathSourceOther") || "その他"]
          : [])
      ],
      cold_bath_cooling_male: [
        ...checkedValues("maleColdBathCooling"),
        ...(checkedBool("maleColdBathCoolingOtherCheck")
          ? [value("maleColdBathCoolingOther") || "その他"]
          : [])
      ],
      cold_bath_flow_male: [
        ...checkedValues("maleColdBathFlow"),
        ...(checkedBool("maleColdBathFlowOtherCheck")
          ? [value("maleColdBathFlowOther") || "その他"]
          : [])
      ],
      cold_bath_temp_min_male: numberValue("maleColdBathTempMin"),
      cold_bath_temp_max_male: numberValue("maleColdBathTempMax"),
      cold_bath_capacity_male: numberValue("maleColdBathCapacity"),
      cold_bath_depth_male: numberValue("maleColdBathDepth"),
      cold_shower_male: radioValue("maleColdShower"),
      cold_bath_note_male: value("maleColdBathNote"),

      outdoor_male: radioValue("maleOutdoor"),
      outdoor_location_male: [
        ...checkedValues("maleOutdoorLocation"),
        ...(checkedBool("maleOutdoorLocationOtherCheck")
          ? [value("maleOutdoorLocationOther") || "その他"]
          : [])
      ],
      indoor_bathing_male: radioValue("maleIndoorBathing"),
      indoor_location_male: [
        ...checkedValues("maleIndoorLocation"),
        ...(checkedBool("maleIndoorLocationOtherCheck")
          ? [value("maleIndoorLocationOther") || "その他"]
          : [])
      ],
      tori_toi_chair_male: radioValue("maleToriToiChair"),
      tori_toi_chair_count_male: numberValue("maleToriToiChairCount"),
      recline_chair_male: radioValue("maleReclineChair"),
      recline_chair_count_male: numberValue("maleReclineChairCount"),
      infinity_chair_male: radioValue("maleInfinityChair"),
      infinity_chair_count_male: numberValue("maleInfinityChairCount"),
      bench_male: radioValue("maleBench"),
      bench_count_male: numberValue("maleBenchCount"),
      deck_chair_male: radioValue("maleDeckChair"),
      deck_chair_count_male: numberValue("maleDeckChairCount"),
      laying_space_male: radioValue("maleLayingSpace"),
      laying_space_material_male: [
        ...checkedValues("maleLayingSpaceMaterial"),
        ...(checkedBool("maleLayingSpaceMaterialOtherCheck")
          ? [value("maleLayingSpaceMaterialOther") || "その他"]
          : [])
      ],
      tori_toi_other_note_male: value("maleToriToiOtherNote"),
      roof_rain_protection_male: radioValue("maleRoofRainProtection"),
      sun_shade_male: radioValue("maleSunShade"),
      scenery_male: [
        ...checkedValues("maleScenery"),
        ...(checkedBool("maleSceneryOtherCheck")
          ? [value("maleSceneryOther") || "その他"]
          : [])
      ],
      outdoor_indoor_note_male: value("maleOutdoorIndoorNote"),

      // 🧖‍♀️ サウナ関連
      sauna_facility_female: radioValue("femaleSaunaFacility"),
      sauna_facility_suspended_female: checkedBool("femaleSaunaFacilitySuspended"),
      sauna_facility_location_female:
        radioValue("femaleSaunaFacilityLocation") === "その他" && value("femaleSaunaFacilityLocationOther")
          ? value("femaleSaunaFacilityLocationOther")
          : radioValue("femaleSaunaFacilityLocation"),
      sauna_hours_type_female: radioValue("femaleSaunaHoursType"),
      sauna_hours_weekday_open_female: timeValue("saunaHoursWeekdayOpen"),
      sauna_hours_weekday_close_female: timeValue("saunaHoursWeekdayClose"),
      sauna_hours_saturday_open_female: timeValue("saunaHoursSaturdayOpen"),
      sauna_hours_saturday_close_female: timeValue("saunaHoursSaturdayClose"),
      sauna_hours_sunday_open_female: timeValue("saunaHoursSundayOpen"),
      sauna_hours_sunday_close_female: timeValue("saunaHoursSundayClose"),
      sauna_hours_holiday_open_female: timeValue("saunaHoursHolidayOpen"),
      sauna_hours_holiday_close_female: timeValue("saunaHoursHolidayClose"),
      sauna_types_female: [
        ...checkedValues("femaleSaunaTypes"),
        ...(checkedBool("femaleSaunaTypesOtherCheck")
          ? [value("femaleSaunaTypesOther") || "その他"]
          : [])
      ],
      sauna_temp_min_female: numberValue("femaleSaunaTempMin"),
      sauna_temp_max_female: numberValue("femaleSaunaTempMax"),
      sauna_humidity_min_female: numberValue("femaleSaunaHumidityMin"),
      sauna_humidity_max_female: numberValue("femaleSaunaHumidityMax"),
      sauna_capacity_number_female: numberValue("femaleSaunaCapacityNumber"),
      sauna_capacity_range_female: value("femaleSaunaCapacityRange"),
      sauna_thermometer_female: radioValue("femaleSaunaThermometer"),
      sauna_clock_female: radioValue("femaleSaunaClock"),
      sauna_twelve_min_timer_female: radioValue("femaleSaunaTwelveMinTimer"),
      sauna_hourglass_female: radioValue("femaleSaunaHourglass"),
      sauna_tv_female: radioValue("femaleSaunaTv"),
      sauna_tv_remote_female: radioValue("femaleSaunaTvRemote"),
      sauna_emergency_button_female: radioValue("femaleSaunaEmergencyButton"),
      sauna_stones_female: radioValue("femaleSaunaStones"),
      sauna_stove_type_female:
        radioValue("femaleSaunaStoveType") === "その他" && value("femaleSaunaStoveTypeOther")
          ? value("femaleSaunaStoveTypeOther")
          : radioValue("femaleSaunaStoveType"),
      sauna_stove_count_status_female: radioValue("femaleSaunaStoveCountStatus"),
      sauna_stove_count_female: numberValue("femaleSaunaStoveCount"),
      sauna_stove_brand_female: value("femaleSaunaStoveBrand"),
      sauna_mat_rental_female: radioValue("femaleSaunaMatRental"),
      sauna_mat_type_female: [
        ...checkedValues("femaleSaunaMatType"),
        ...(checkedBool("femaleSaunaMatTypeOtherCheck")
          ? [value("femaleSaunaMatTypeOther") || "その他"]
          : [])
      ],
      sauna_mat_placement_female: [
        ...checkedValues("femaleSaunaMatPlacement"),
        ...(checkedBool("femaleSaunaMatPlacementOtherCheck")
          ? [value("femaleSaunaMatPlacementOther") || "その他"]
          : [])
      ],
      sauna_goods_rental_female: radioValue("femaleSaunaGoodsRental"),
      sauna_goods_sale_female: radioValue("femaleSaunaGoodsSale"),
      sauna_loyly_female: radioValue("femaleSaunaLoyly"),
      sauna_loyly_type_female: [
        ...checkedValues("femaleSaunaLoylyType"),
        ...(checkedBool("femaleSaunaLoylyTypeOtherCheck")
          ? [value("femaleSaunaLoylyTypeOther") || "その他"]
          : [])
      ],
      sauna_aroma_loyly_female: radioValue("femaleSaunaAromaLoyly"),
      sauna_aroma_type_female: value("femaleSaunaAromaType"),
      sauna_aufguss_female: radioValue("femaleSaunaAufguss"),
      sauna_loyly_frequency_female: radioValue("femaleSaunaLoylyFrequency"),
      sauna_loyly_interval_minutes_female: numberValue("femaleSaunaLoylyIntervalMinutes"),
      sauna_loyly_interval_note_female: value("femaleSaunaLoylyIntervalNote"),
      sauna_loyly_reservation_female: radioValue("femaleSaunaLoylyReservation"),
      sauna_loyly_note_female: value("femaleSaunaLoylyNote"),
      sauna_door_type_female:
        radioValue("femaleSaunaDoorType") === "その他" && value("femaleSaunaDoorTypeOther")
          ? value("femaleSaunaDoorTypeOther")
          : radioValue("femaleSaunaDoorType"),
      sauna_exit_direction_female: radioValue("femaleSaunaExitDirection"),
      sauna_light_brightness_female: radioValue("femaleSaunaLightBrightness"),
      sauna_room_note_female: value("femaleSaunaRoomNote"),

      cold_bath_availability_female: radioValue("femaleColdBathAvailability"),
      cold_bath_count_female: numberValue("femaleColdBathCount"),
      cold_bath_shape_female: checkedValues("femaleColdBathShape"),
      cold_bath_location_female: checkedValues("femaleColdBathLocation"),
      cold_bath_source_female: [
        ...checkedValues("femaleColdBathSource"),
        ...(checkedBool("femaleColdBathSourceOtherCheck")
          ? [value("femaleColdBathSourceOther") || "その他"]
          : [])
      ],
      cold_bath_cooling_female: [
        ...checkedValues("femaleColdBathCooling"),
        ...(checkedBool("femaleColdBathCoolingOtherCheck")
          ? [value("femaleColdBathCoolingOther") || "その他"]
          : [])
      ],
      cold_bath_flow_female: [
        ...checkedValues("femaleColdBathFlow"),
        ...(checkedBool("femaleColdBathFlowOtherCheck")
          ? [value("femaleColdBathFlowOther") || "その他"]
          : [])
      ],
      cold_bath_temp_min_female: numberValue("femaleColdBathTempMin"),
      cold_bath_temp_max_female: numberValue("femaleColdBathTempMax"),
      cold_bath_capacity_female: numberValue("femaleColdBathCapacity"),
      cold_bath_depth_female: numberValue("femaleColdBathDepth"),
      cold_shower_female: radioValue("femaleColdShower"),
      cold_bath_note_female: value("femaleColdBathNote"),

      outdoor_female: radioValue("femaleOutdoor"),
      outdoor_location_female: [
        ...checkedValues("femaleOutdoorLocation"),
        ...(checkedBool("femaleOutdoorLocationOtherCheck")
          ? [value("femaleOutdoorLocationOther") || "その他"]
          : [])
      ],
      indoor_bathing_female: radioValue("femaleIndoorBathing"),
      indoor_location_female: [
        ...checkedValues("femaleIndoorLocation"),
        ...(checkedBool("femaleIndoorLocationOtherCheck")
          ? [value("femaleIndoorLocationOther") || "その他"]
          : [])
      ],
      tori_toi_chair_female: radioValue("femaleToriToiChair"),
      tori_toi_chair_count_female: numberValue("femaleToriToiChairCount"),
      recline_chair_female: radioValue("femaleReclineChair"),
      recline_chair_count_female: numberValue("femaleReclineChairCount"),
      infinity_chair_female: radioValue("femaleInfinityChair"),
      infinity_chair_count_female: numberValue("femaleInfinityChairCount"),
      bench_female: radioValue("femaleBench"),
      bench_count_female: numberValue("femaleBenchCount"),
      deck_chair_female: radioValue("femaleDeckChair"),
      deck_chair_count_female: numberValue("femaleDeckChairCount"),
      laying_space_female: radioValue("femaleLayingSpace"),
      laying_space_material_female: [
        ...checkedValues("femaleLayingSpaceMaterial"),
        ...(checkedBool("femaleLayingSpaceMaterialOtherCheck")
          ? [value("femaleLayingSpaceMaterialOther") || "その他"]
          : [])
      ],
      tori_toi_other_note_female: value("femaleToriToiOtherNote"),
      roof_rain_protection_female: radioValue("femaleRoofRainProtection"),
      sun_shade_female: radioValue("femaleSunShade"),
      scenery_female: [
        ...checkedValues("femaleScenery"),
        ...(checkedBool("femaleSceneryOtherCheck")
          ? [value("femaleSceneryOther") || "その他"]
          : [])
      ],
      outdoor_indoor_note_female: value("femaleOutdoorIndoorNote"),

      // 🚿 シャワー
      shower_count_male: value("maleShowerCount"),
      shower_type_male: [
        ...checkedValues("maleShowerType"),
        ...(checkedBool("maleShowerTypeOtherCheck")
          ? [value("maleShowerTypeOther") || "その他"]
          : [])
      ],
      shower_head_info_male: value("maleShowerHeadInfo"),
      shower_faucet_male: radioValue("maleShowerFaucet"),
      shower_booth_male: radioValue("maleShowerBooth"),
      wash_area_divider_male: radioValue("maleWashAreaDivider"),
      bath_trash_bin_male: radioValue("maleBathTrashBin"),
      pre_rinse_water_male: radioValue("malePreRinseWater"),
      shower_note_male: value("maleShowerNote"),

      // 🧴 アメニティ・備品
      shampoo_conditioner_male: radioValue("maleShampooConditioner"),
      body_soap_male: radioValue("maleBodySoap"),
      soap_male: radioValue("maleSoap"),
      face_wash_male: radioValue("maleFaceWash"),
      cleansing_male: radioValue("maleCleansing"),
      basin_male: radioValue("maleBasin"),
      bath_chair_male: radioValue("maleBathChair"),
      shower_chair_male: radioValue("maleShowerChair"),
      rental_items_male: collectRentalItems("maleRentalRows"),
      dryer_status_male: radioValue("maleDryerStatus"),
      dryer_count_male: value("maleDryerCount"),
      dryer_fee_male: radioValue("maleDryerFee"),
      dryer_brand_male: value("maleDryerBrand"),
      dryer_bring_own_male: radioValue("maleDryerBringOwn"),
      tissue_male: radioValue("maleTissue"),
      cotton_swab_male: radioValue("maleCottonSwab"),
      cosmetics_male: radioValue("maleCosmetics"),
      hair_tie_male: radioValue("maleHairTie"),
      powder_room_male: radioValue("malePowderRoom"),
      vanity_male: radioValue("maleVanity"),
      water_cooler_male: radioValue("maleWaterCooler"),
      fan_male: radioValue("maleFan"),
      scale_male: radioValue("maleScale"),
      blood_pressure_monitor_male: radioValue("maleBloodPressureMonitor"),
      trash_bin_male: radioValue("maleTrashBin"),
      locker_room_chair_male: radioValue("maleLockerRoomChair"),
      baby_chair_male: radioValue("maleBabyChair"),
      baby_bed_male: radioValue("maleBabyBed"),
      amenity_note_male: value("maleAmenityNote"),

      // 🚿 シャワー
      shower_count_female: value("femaleShowerCount"),
      shower_type_female: [
        ...checkedValues("femaleShowerType"),
        ...(checkedBool("femaleShowerTypeOtherCheck")
          ? [value("femaleShowerTypeOther") || "その他"]
          : [])
      ],
      shower_head_info_female: value("femaleShowerHeadInfo"),
      shower_faucet_female: radioValue("femaleShowerFaucet"),
      shower_booth_female: radioValue("femaleShowerBooth"),
      wash_area_divider_female: radioValue("femaleWashAreaDivider"),
      bath_trash_bin_female: radioValue("femaleBathTrashBin"),
      pre_rinse_water_female: radioValue("femalePreRinseWater"),
      shower_note_female: value("femaleShowerNote"),

      // 🧴 アメニティ・備品
      shampoo_conditioner_female: radioValue("femaleShampooConditioner"),
      body_soap_female: radioValue("femaleBodySoap"),
      soap_female: radioValue("femaleSoap"),
      face_wash_female: radioValue("femaleFaceWash"),
      cleansing_female: radioValue("femaleCleansing"),
      basin_female: radioValue("femaleBasin"),
      bath_chair_female: radioValue("femaleBathChair"),
      shower_chair_female: radioValue("femaleShowerChair"),
      rental_items_female: collectRentalItems("femaleRentalRows"),
      dryer_status_female: radioValue("femaleDryerStatus"),
      dryer_count_female: value("femaleDryerCount"),
      dryer_fee_female: radioValue("femaleDryerFee"),
      dryer_brand_female: value("femaleDryerBrand"),
      dryer_bring_own_female: radioValue("femaleDryerBringOwn"),
      tissue_female: radioValue("femaleTissue"),
      cotton_swab_female: radioValue("femaleCottonSwab"),
      cosmetics_female: radioValue("femaleCosmetics"),
      hair_tie_female: radioValue("femaleHairTie"),
      powder_room_female: radioValue("femalePowderRoom"),
      vanity_female: radioValue("femaleVanity"),
      water_cooler_female: radioValue("femaleWaterCooler"),
      fan_female: radioValue("femaleFan"),
      scale_female: radioValue("femaleScale"),
      blood_pressure_monitor_female: radioValue("femaleBloodPressureMonitor"),
      trash_bin_female: radioValue("femaleTrashBin"),
      locker_room_chair_female: radioValue("femaleLockerRoomChair"),
      baby_chair_female: radioValue("femaleBabyChair"),
      baby_bed_female: radioValue("femaleBabyBed"),
      amenity_note_female: value("femaleAmenityNote"),

      // 🔐 ロッカー
      locker_count_male: value("maleLockerCount"),
      locker_key_type_male: [
        ...checkedValues("maleLockerKeyType"),
        ...(checkedBool("maleLockerKeyTypeOtherCheck")
          ? [value("maleLockerKeyTypeOther") || "その他"]
          : [])
      ],
      locker_wristband_type_male: [
        ...checkedValues("maleLockerWristbandType"),
        ...(checkedBool("maleLockerWristbandTypeOtherCheck")
          ? [value("maleLockerWristbandTypeOther") || "その他"]
          : [])
      ],
      locker_wristband_use_male: [
        ...checkedValues("maleLockerWristbandUse"),
        ...(checkedBool("maleLockerWristbandUseOtherCheck")
          ? [value("maleLockerWristbandUseOther") || "その他"]
          : [])
      ],
      locker_size_male: [
        ...checkedValues("maleLockerSize"),
        ...(checkedBool("maleLockerSizeOtherCheck")
          ? [value("maleLockerSizeOther") || "その他"]
          : [])
      ],
      locker_divider_male: radioValue("maleLockerDivider"),
      locker_hanger_male: radioValue("maleLockerHanger"),
      locker_small_item_box_male: radioValue("maleLockerSmallItemBox"),
      locker_valuables_male: radioValue("maleLockerValuables"),
      locker_rental_male: radioValue("maleLockerRental"),
      locker_suitcase_male: radioValue("maleLockerSuitcase"),
      locker_note_male: value("maleLockerNote"),

      // 👟 靴箱
      shoebox_count_male: value("maleShoeboxCount"),
      shoebox_type_male: [
        ...checkedValues("maleShoeboxType"),
        ...(checkedBool("maleShoeboxTypeOtherCheck")
          ? [value("maleShoeboxTypeOther") || "その他"]
          : [])
      ],
      shoebox_key_type_male: [
        ...checkedValues("maleShoeboxKeyType"),
        ...(checkedBool("maleShoeboxKeyTypeOtherCheck")
          ? [value("maleShoeboxKeyTypeOther") || "その他"]
          : [])
      ],
      shoebox_fee_male: radioValue("maleShoeboxFee"),
      shoebox_note_male: value("maleShoeboxNote"),

      // 🔐 ロッカー
      locker_count_female: value("femaleLockerCount"),
      locker_key_type_female: [
        ...checkedValues("femaleLockerKeyType"),
        ...(checkedBool("femaleLockerKeyTypeOtherCheck")
          ? [value("femaleLockerKeyTypeOther") || "その他"]
          : [])
      ],
      locker_wristband_type_female: [
        ...checkedValues("femaleLockerWristbandType"),
        ...(checkedBool("femaleLockerWristbandTypeOtherCheck")
          ? [value("femaleLockerWristbandTypeOther") || "その他"]
          : [])
      ],
      locker_wristband_use_female: [
        ...checkedValues("femaleLockerWristbandUse"),
        ...(checkedBool("femaleLockerWristbandUseOtherCheck")
          ? [value("femaleLockerWristbandUseOther") || "その他"]
          : [])
      ],
      locker_size_female: [
        ...checkedValues("femaleLockerSize"),
        ...(checkedBool("femaleLockerSizeOtherCheck")
          ? [value("femaleLockerSizeOther") || "その他"]
          : [])
      ],
      locker_divider_female: radioValue("femaleLockerDivider"),
      locker_hanger_female: radioValue("femaleLockerHanger"),
      locker_small_item_box_female: radioValue("femaleLockerSmallItemBox"),
      locker_valuables_female: radioValue("femaleLockerValuables"),
      locker_rental_female: radioValue("femaleLockerRental"),
      locker_suitcase_female: radioValue("femaleLockerSuitcase"),
      locker_note_female: value("femaleLockerNote"),

      // 👟 靴箱
      shoebox_count_female: value("femaleShoeboxCount"),
      shoebox_type_female: [
        ...checkedValues("femaleShoeboxType"),
        ...(checkedBool("femaleShoeboxTypeOtherCheck")
          ? [value("femaleShoeboxTypeOther") || "その他"]
          : [])
      ],
      shoebox_key_type_female: [
        ...checkedValues("femaleShoeboxKeyType"),
        ...(checkedBool("femaleShoeboxKeyTypeOtherCheck")
          ? [value("femaleShoeboxKeyTypeOther") || "その他"]
          : [])
      ],
      shoebox_fee_female: radioValue("femaleShoeboxFee"),
      shoebox_note_female: value("femaleShoeboxNote"),

      // 🚻 トイレ・バリアフリー
      toilet_location_lobby: radioValue("toiletLocationLobby"),
      toilet_mens_changing_room: radioValue("toiletMensChangingRoom"),
      toilet_womens_changing_room: radioValue("toiletWomensChangingRoom"),
      toilet_location_other: value("toiletLocationOther"),
      toilet_types: [
        ...checkedValues("toiletTypes"),
        ...(checkedBool("toiletTypesOtherCheck")
          ? [value("toiletTypesOther") || "その他"]
          : [])
      ],
      toilet_accessible: radioValue("toiletAccessible"),
      toilet_wheelchair: radioValue("toiletWheelchair"),
      toilet_ostomate: radioValue("toiletOstomate"),
      toilet_diaper_table: radioValue("toiletDiaperTable"),
      toilet_baby_chair_in_toilet: radioValue("toiletBabyChairInToilet"),
      toilet_slope: radioValue("toiletSlope"),
      toilet_elevator: radioValue("toiletElevator"),
      toilet_barrier_free_note: value("toiletBarrierFreeNote"),

      // 🍴 お食事処
      restaurant_status: radioValue("restaurantStatus"),
      restaurant_types: [
        ...checkedValues("restaurantTypes"),
        ...(checkedBool("restaurantTypesOtherCheck")
          ? [value("restaurantTypesOther") || "その他"]
          : [])
      ],
      restaurant_feature: value("restaurantFeature"),
      restaurant_hours_type: radioValue("restaurantHoursType"),
      restaurant_additional_hours: collectHoursRangeRows("restaurantAdditionalHoursRows"),
      restaurant_open_time: timeValue("restaurantOpenTime"),
      restaurant_close_time: timeValue("restaurantCloseTime"),
      restaurant_last_order: timeValue("restaurantLastOrder"),
      restaurant_payment: [
        ...checkedValues("restaurantPayment"),
        ...(checkedBool("restaurantPaymentOtherCheck")
          ? [value("restaurantPaymentOther") || "その他"]
          : [])
      ],
      restaurant_other_info: [
        ...checkedValues("restaurantOtherInfo"),
        ...(checkedBool("restaurantOtherInfoOtherCheck")
          ? [value("restaurantOtherInfoOther") || "その他"]
          : [])
      ],
      restaurant_note: value("restaurantNote"),

      // 🛋 休憩スペース
      rest_space_status: radioValue("restSpaceStatus"),
      rest_space_type: [
        ...checkedValues("restSpaceType"),
        ...(checkedBool("restSpaceTypeOtherCheck")
          ? [value("restSpaceTypeOther") || "その他"]
          : [])
      ],
      rest_space_condition: radioValue("restSpaceCondition"),
      rest_space_fee_type: radioValue("restSpaceFeeType"),
      rest_space_fee_amount: numberValue("restSpaceFeeAmount"),
      rest_space_hours_type: radioValue("restSpaceHoursType"),
      rest_space_hours_open: timeValue("restSpaceHoursOpen"),
      rest_space_hours_close: timeValue("restSpaceHoursClose"),
      rest_space_per_person_type: radioValue("restSpacePerPersonType"),
      rest_space_per_person_minutes: numberValue("restSpacePerPersonMinutes"),
      rest_space_note: value("restSpaceNote"),

      // 💆‍♀️ マッサージ・リラクゼーション
      massage_status: radioValue("massageStatus"),
      massage_types: [
        ...checkedValues("massageTypes"),
        ...(checkedBool("massageTypesOtherCheck")
          ? [value("massageTypesOther") || "その他"]
          : [])
      ],
      massage_menu_fees: collectFeeRows3("massageFeeRows"),
      massage_hours_type: radioValue("massageHoursType"),
      massage_hours_open: timeValue("massageHoursOpen"),
      massage_hours_close: timeValue("massageHoursClose"),
      massage_additional_hours: collectHoursRangeRows("massageAdditionalHoursRows"),
      massage_chair_status: radioValue("massageChairStatus"),
      massage_chair_count: numberValue("massageChairCount"),
      massage_chair_minutes: numberValue("massageChairMinutes"),
      massage_chair_price: numberValue("massageChairPrice"),
      massage_note: value("massageNote"),

      // 💬 レンタル・コワーキングスペース
      rental_space_status: radioValue("rentalSpaceStatus"),
      coworking_space_status: radioValue("coworkingSpaceStatus"),
      coworking_features: [
        ...checkedValues("coworkingFeatures"),
        ...(checkedBool("coworkingFeaturesOtherCheck")
          ? [value("coworkingFeaturesOther") || "その他"]
          : [])
      ],
      coworking_note: value("coworkingNote"),

      // 🥤 自動販売機
      vending_machine_status: radioValue("vendingMachineStatus"),
      vending_machine_types: [
        ...checkedValues("vendingMachineTypes"),
        ...(checkedBool("vendingMachineTypesOtherCheck")
          ? [value("vendingMachineTypesOther") || "その他"]
          : [])
      ],
      vending_machine_location: [
        ...checkedValues("vendingMachineLocation"),
        ...(checkedBool("vendingMachineLocationOtherCheck")
          ? [value("vendingMachineLocationOther") || "その他"]
          : [])
      ],
      recycle_box_status: radioValue("recycleBoxStatus"),
      vending_machine_note: value("vendingMachineNote"),

      // 🛍 売店コーナー
      shop_status: radioValue("shopStatus"),
      shop_items: [
        ...checkedValues("shopItems"),
        ...(checkedBool("shopItemsOtherCheck")
          ? [value("shopItemsOther") || "その他"]
          : [])
      ],
      shop_hours_type: radioValue("shopHoursType"),
      shop_hours_open: timeValue("shopHoursOpen"),
      shop_hours_close: timeValue("shopHoursClose"),
      shop_additional_hours: collectHoursRangeRows("shopAdditionalHoursRows"),
      convenience_store_status: radioValue("convenienceStoreStatus"),
      convenience_store_hours_type: radioValue("convenienceStoreHoursType"),
      convenience_store_hours: collectHoursRangeRows("convenienceStoreHoursRows"),
      shop_payment: [
        ...checkedValues("shopPayment"),
        ...(checkedBool("shopPaymentOtherCheck")
          ? [value("shopPaymentOther") || "その他"]
          : [])
      ],
      shop_note: value("shopNote"),

      // その他の各種施設
      accommodation_status: radioValue("accommodationStatus"),
      pool_facility_status: radioValue("poolFacilityStatus"),
      game_corner_status: radioValue("gameCornerStatus"),
      kids_corner_status: radioValue("kidsCornerStatus"),
      outdoor_facility_status: radioValue("outdoorFacilityStatus"),
      foot_bath_status: radioValue("footBathStatus"),
      ganbanyoku_status: radioValue("ganbanyokuStatus"),
      coin_laundry_status: radioValue("coinLaundryStatus"),
      spring_takeaway_status: radioValue("springTakeawayStatus"),
      onsen_tamago_status: radioValue("onsenTamagoStatus"),
      wifi_facility: radioValue("wifiFacility"),
      wifi_fee_minutes: numberValue("wifiFeeMinutes"),
      wifi_fee_price: numberValue("wifiFeePrice"),
      charging_spot: radioValue("chargingSpot"),
      charging_fee_minutes: numberValue("chargingFeeMinutes"),
      charging_fee_price: numberValue("chargingFeePrice"),
      aed_facility_status: radioValue("aedFacilityStatus"),
      first_aid_room_status: radioValue("firstAidRoomStatus"),
      other_facility_note: value("otherFacilityNote"),

      // 🅿️ 駐車場・駐輪場
      parking_status: radioValue("parkingStatus"),
      parking_capacity: value("parkingCapacity"),
      parking_fee_type: radioValue("parkingFeeType"),
      parking_fee_amount: numberValue("parkingFeeAmount"),
      parking_conditions: [
        ...checkedValues("parkingConditions"),
        ...(checkedBool("parkingFreeHoursCheck") && value("parkingFreeHours")
          ? [`${value("parkingFreeHours")}時間無料`]
          : []),
        ...(checkedBool("parkingConditionsOtherCheck")
          ? [value("parkingConditionsOther") || "その他"]
          : [])
      ],
      parking_types: [
        ...checkedValues("parkingTypes"),
        ...(checkedBool("parkingTypesOtherCheck")
          ? [value("parkingTypesOther") || "その他"]
          : [])
      ],
      parking_accessible: [
        ...checkedValues("parkingAccessible"),
        ...(checkedBool("parkingAccessibleOtherCheck")
          ? [value("parkingAccessibleOther") || "その他"]
          : [])
      ],
      parking_temporary: radioValue("parkingTemporary"),
      motorcycle_parking: radioValue("motorcycleParking"),
      bicycle_parking: radioValue("bicycleParking"),
      parking_note: value("parkingNote"),

      // 📢 お知らせ・イベント情報
      notice_info: value("noticeInfo"),
      event_info: value("eventInfo"),

      // ⭐️ ユーザー情報
      last_visit_date: dateValue("lastVisitDate"),
      last_info_check_date: dateValue("lastInfoCheckDate"),
      user_info_source: [
        ...checkedValues("userInfoSource"),
        ...(checkedBool("userInfoSourceOtherCheck")
          ? [value("userInfoSourceOther") || "その他"]
          : [])
      ],

      // 📍 位置情報・メモ

      lat: numberValue("lat"),
      lng: numberValue("lng"),
      google_maps_url: value("googleMapsUrl"),
      note: value("note"),

      // アプリ側で管理する情報
      updated_at: new Date().toISOString()
    };
  }

  // ---------------------------------------------------------
  // 編集用：フォームへの値の書き戻し
  // ---------------------------------------------------------

  function setValue(id, val) {
    const el = $(id);
    if (!el) return;
    el.value = val ?? "";
  }

  function setRadioValue(name, val) {
    if (!val) return;
    document.querySelectorAll(`input[name="${name}"]`).forEach((el) => {
      el.checked = el.value === val;
    });
  }

  function setCheckboxGroup(name, knownValues, values, otherCheckId, otherInputId) {
    if (!Array.isArray(values) || !values.length) return;

    const knownSet = new Set(knownValues);

    document.querySelectorAll(`input[name="${name}"]`).forEach((el) => {
      el.checked = values.includes(el.value);
    });

    if (!otherCheckId) return;

    const otherValues = values.filter((v) => !knownSet.has(v));
    const otherCheck = $(otherCheckId);
    const otherInput = $(otherInputId);

    if (otherCheck && otherValues.length) {
      otherCheck.checked = true;
      otherCheck.dispatchEvent(new Event("change"));
    }
    if (otherInput && otherValues.length) {
      otherInput.value = otherValues.join("、");
    }
  }

  function setTimeValue(prefix, hhmm) {
    if (!hhmm) return;
    const [h, m] = hhmm.split(":");
    if ($(`${prefix}Hour`)) $(`${prefix}Hour`).value = h || "";
    if ($(`${prefix}Minute`)) $(`${prefix}Minute`).value = m || "";
  }

  function setDateValue(prefix, dateStr) {
    if (!dateStr) return;
    const [y, m, d] = dateStr.split("-");
    if ($(`${prefix}Year`)) $(`${prefix}Year`).value = y || "";
    if ($(`${prefix}Month`)) $(`${prefix}Month`).value = m ? String(Number(m)) : "";
    if ($(`${prefix}Day`)) $(`${prefix}Day`).value = d ? String(Number(d)) : "";
  }

  function populateFeeRows(containerId, fees) {
    const rows = $(containerId);
    if (!rows) return;
    rows.innerHTML = "";
    if (!Array.isArray(fees) || !fees.length) return;

    fees.forEach((f) =>
      addFeeRow(containerId, f.category || "", f.amount ?? "", { focus: false })
    );
  }

  function populateRentalItems(containerId, items) {
    const rows = $(containerId);
    if (!rows) return;
    rows.innerHTML = "";
    if (!Array.isArray(items) || !items.length) return;

    items.forEach((entry) => {
      const match = /^(.*)（(\d+)円）$/.exec(entry);
      if (match) {
        addRentalRow(containerId, match[1], match[2], { focus: false });
      } else {
        addRentalRow(containerId, entry, "", { focus: false });
      }
    });
  }

  function populateForm(item) {
    setValue("name", item.name);
    setValue("prefecture", item.prefecture);
    populateAreaOptions(item.prefecture, item.area);

    if (item.business_type && !BUSINESS_TYPE_STYLES[item.business_type]) {
      setValue("businessType", "その他");
      setValue("businessTypeOther", item.business_type);
      $("businessTypeOtherWrap")?.classList.remove("hidden");
    } else {
      setValue("businessType", item.business_type);
    }

    setCheckboxGroup(
      "usage",
      ["日帰り入浴可", "宿泊者のみ", "会員制", "要予約", "要確認", "男性専用", "女性専用", "水着着用"],
      item.usage,
      "usageOtherCheck",
      "usageOther"
    );

    setValue("address", item.address);
    setValue("phone", item.phone);

    const springTypeKnown = ["不明", "天然温泉", "人工温泉", "天然温泉 + 人工温泉"];
    if (springTypeKnown.includes(item.spring_type)) {
      setRadioValue("springType", item.spring_type);
    } else if (item.spring_type) {
      setRadioValue("springType", "その他");
      setValue("springTypeOther", item.spring_type);
      $("springTypeOther")?.classList.remove("hidden");
    }

    const sourceTypeKnown = ["不明", "自家源泉", "共同源泉", "引湯", "運び湯"];
    if (sourceTypeKnown.includes(item.source_type)) {
      setRadioValue("sourceType", item.source_type);
    } else if (item.source_type) {
      setRadioValue("sourceType", "その他");
      setValue("sourceTypeOther", item.source_type);
      $("sourceTypeOther")?.classList.remove("hidden");
    }
    setValue("nearestStation", item.nearest_station);
    setValue("accessMethod", item.access_method);

    if (item.is_24_hours) {
      $("is24Hours").checked = true;
      $("normalHoursWrap")?.classList.add("hidden");
    }
    setTimeValue("openTime", item.open_time);
    setTimeValue("closeTime", item.close_time);
    setTimeValue("lastEntry", item.last_entry);
    if (Array.isArray(item.closed_days)) {
      document.querySelectorAll('input[name="closedDay"]').forEach((el) => {
        el.checked = item.closed_days.includes(el.value);
      });
    }
    if (item.is_temp_closed) $("tempClosed").checked = true;
    setValue("tempClosedDetail", item.temp_closed_detail);
    if (item.is_closed) $("closedPermanently").checked = true;
    setTimeValue("overnightOpen", item.overnight_open_time);
    setTimeValue("overnightClose", item.overnight_close_time);
    setTimeValue("overnightLastEntry", item.overnight_last_entry);
    setCheckboxGroup("overnightDays", ["日", "月", "火", "水", "木", "金", "土", "祝"], item.overnight_days);
    populateHoursRangeRows("overnightAdditionalHoursRows", item.overnight_additional_hours, { withLastEntry: true, withDays: true });
    setTimeValue("morningBathOpen", item.morning_bath_open_time);
    setTimeValue("morningBathClose", item.morning_bath_close_time);
    setTimeValue("morningBathLastEntry", item.morning_bath_last_entry);
    setCheckboxGroup("morningBathDays", ["日", "月", "火", "水", "木", "金", "土", "祝"], item.morning_bath_days);
    populateHoursRangeRows("morningBathAdditionalHoursRows", item.morning_bath_additional_hours, { withLastEntry: true, withDays: true });
    setValue("otherHoursLabel", item.other_hours_label);
    setTimeValue("otherHoursOpen", item.other_hours_open_time);
    setTimeValue("otherHoursClose", item.other_hours_close_time);
    setTimeValue("otherHoursLastEntry", item.other_hours_last_entry);
    setCheckboxGroup("otherHoursDays", ["日", "月", "火", "水", "木", "金", "土", "祝"], item.other_hours_days);
    populateHoursRangeRows("otherHoursAdditionalHoursRows", item.other_hours_additional_hours, { withLastEntry: true, withDays: true });
    if (Array.isArray(item.closed_nth_weeks) && item.closed_nth_weeks.length) {
      $("closedNthWeekdayEnabled").checked = true;
      $("closedNthWeekdayWrap")?.classList.remove("hidden");
      setCheckboxGroup("closedNthWeek", ["第1", "第2", "第3", "第4", "第5", "最終"], item.closed_nth_weeks);
    }
    setValue("closedNthWeekday", item.closed_nth_weekday);
    if (item.closed_monthly_dates) {
      $("closedMonthlyDatesEnabled").checked = true;
      $("closedMonthlyDatesWrap")?.classList.remove("hidden");
      setValue("closedMonthlyDates", item.closed_monthly_dates);
    }
    if (item.closed_irregular) $("closedIrregular").checked = true;
    if (item.closed_calendar_based) $("closedCalendarBased").checked = true;
    setRadioValue("closedHolidayRule", item.closed_holiday_rule || "");
    setValue("closedDayPatternNote", item.closed_day_pattern_note);
    setValue("closedDaysNote", item.closed_days_note);
    (() => {
      const dayChars = { sun: "日", mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", holiday: "祝" };
      const overrides = item.weekday_hours_overrides || {};
      Object.entries(dayChars).forEach(([code, ch]) => {
        const entry = overrides[ch];
        if (entry) {
          if ($(`weekdayHoursEnabled_${code}`)) $(`weekdayHoursEnabled_${code}`).checked = true;
          $(`weekdayHoursWrap_${code}`)?.classList.remove("hidden");
          setTimeValue(`weekdayHoursOpen_${code}`, entry.open);
          setTimeValue(`weekdayHoursClose_${code}`, entry.close);
          setTimeValue(`weekdayHoursLastEntry_${code}`, entry.lastEntry);
        }
      });
    })();
    setValue("hoursNote", item.hours_note);

    populateFeeRows("bathFeeRows", item.bath_fees);
    populateTicketFeeRows("ticketFeeRows", item.ticket_fees);
    populateFeeRows("disabilityFeeRows", item.disability_fees);
    setValue("disabilityFeeNote", item.disability_fee_note);
    populateBenefitRows("memberBenefitRows", item.member_benefits);
    populateBenefitRows("specialCouponRows", item.special_coupons);
    setValue("discountSupplementaryNote", item.discount_supplementary_note);
    populateFeeRows("otherFeeRows", item.other_fees);

    setCheckboxGroup(
      "purchaseMethod",
      ["券売機", "受付購入", "インターネット予約"],
      item.purchase_method,
      "purchaseMethodOtherCheck",
      "purchaseMethodOther"
    );

    setCheckboxGroup(
      "payment",
      ["現金決済", "クレジットカード", "PayPay", "楽天ペイ", "d払い", "au PAY", "QUICPay", "iD", "WAON", "楽天Edy", "交通系電子マネー"],
      item.payment,
      "paymentOtherCheck",
      "paymentOther"
    );

    setRadioValue("pointCard", item.point_card);
    setRadioValue("membershipCard", item.membership_card);
    setRadioValue("wristbandPayment", item.wristband_payment);
    setValue("priceNote", item.price_note);

    setValue("website", item.website);
    setValue("instagram", item.instagram);
    setValue("twitter", item.twitter);
    setValue("facebook", item.facebook);

    setCheckboxGroup(
      "maleBathShape",
      ["大浴場", "個別風呂", "露天風呂・半露天風呂", "展望風呂", "貸切風呂", "家族風呂", "内湯（宿泊者限定）", "壺湯", "釜風呂", "檜風呂", "岩風呂・石風呂", "寝湯・寝ころび湯", "立ち湯", "腰掛け湯", "洞窟風呂", "海水風呂"],
      item.bath_shape_male,
      "maleBathShapeOtherCheck",
      "maleBathShapeOther"
    );
    setCheckboxGroup(
      "maleBathFunction",
      ["炭酸泉・人工炭酸泉", "電気風呂", "ジェットバス", "バイブラバス", "打たせ湯", "薬湯", "香り湯", "源泉掛け流し浴槽", "循環浴槽", "加温浴槽", "高温湯", "ぬるま湯", "水風呂", "冷泉湯", "砂湯", "泥湯"],
      item.bath_function_male,
      "maleBathFunctionOtherCheck",
      "maleBathFunctionOther"
    );
    setValue("malePrivateBathDuration", item.private_bath_duration_male);
    setRadioValue("malePrivateBathCapacityStatus", item.private_bath_capacity_status_male);
    setValue("malePrivateBathCapacity", item.private_bath_capacity_male);
    if (item.private_bath_capacity_status_male === "人数あり") {
      $("malePrivateBathCapacityWrap")?.classList.remove("hidden");
    }
    setValue("malePrivateBathNote", item.private_bath_note_male);
    setCheckboxGroup(
      "maleBathLocation",
      ["固定", "日替わり", "週替わり", "隔週", "時間交代制", "男湯のみ", "女湯のみ", "混浴"],
      item.bath_location_male,
      "maleBathLocationOtherCheck",
      "maleBathLocationOther"
    );
    setRadioValue("maleBathHandrail", item.bath_handrail_male);
    setRadioValue("maleToiletryShelf", item.toiletry_shelf_male);
    setRadioValue("maleBathAnteroom", item.bath_anteroom_male);
    setRadioValue("maleBathEvent", item.bath_event_male);
    setValue("maleBathEventDetail", item.bath_event_detail_male);
    setRadioValue("maleBathToys", item.bath_toys_male);
    setValue("maleBathToysDetail", item.bath_toys_detail_male);
    setValue("maleBathNote", item.bath_note_male);
    setCheckboxGroup(
      "femaleBathShape",
      ["大浴場", "個別風呂", "露天風呂・半露天風呂", "展望風呂", "貸切風呂", "家族風呂", "内湯（宿泊者限定）", "壺湯", "釜風呂", "檜風呂", "岩風呂・石風呂", "寝湯・寝ころび湯", "立ち湯", "腰掛け湯", "洞窟風呂", "海水風呂"],
      item.bath_shape_female,
      "femaleBathShapeOtherCheck",
      "femaleBathShapeOther"
    );
    setCheckboxGroup(
      "femaleBathFunction",
      ["炭酸泉・人工炭酸泉", "電気風呂", "ジェットバス", "バイブラバス", "打たせ湯", "薬湯", "香り湯", "源泉掛け流し浴槽", "循環浴槽", "加温浴槽", "高温湯", "ぬるま湯", "水風呂", "冷泉湯", "砂湯", "泥湯"],
      item.bath_function_female,
      "femaleBathFunctionOtherCheck",
      "femaleBathFunctionOther"
    );
    setValue("femalePrivateBathDuration", item.private_bath_duration_female);
    setRadioValue("femalePrivateBathCapacityStatus", item.private_bath_capacity_status_female);
    setValue("femalePrivateBathCapacity", item.private_bath_capacity_female);
    if (item.private_bath_capacity_status_female === "人数あり") {
      $("femalePrivateBathCapacityWrap")?.classList.remove("hidden");
    }
    setValue("femalePrivateBathNote", item.private_bath_note_female);
    setCheckboxGroup(
      "femaleBathLocation",
      ["固定", "日替わり", "週替わり", "隔週", "時間交代制", "男湯のみ", "女湯のみ", "混浴"],
      item.bath_location_female,
      "femaleBathLocationOtherCheck",
      "femaleBathLocationOther"
    );
    setRadioValue("femaleBathHandrail", item.bath_handrail_female);
    setRadioValue("femaleToiletryShelf", item.toiletry_shelf_female);
    setRadioValue("femaleBathAnteroom", item.bath_anteroom_female);
    setRadioValue("femaleBathEvent", item.bath_event_female);
    setValue("femaleBathEventDetail", item.bath_event_detail_female);
    setRadioValue("femaleBathToys", item.bath_toys_female);
    setValue("femaleBathToysDetail", item.bath_toys_detail_female);
    setValue("femaleBathNote", item.bath_note_female);

    setCheckboxGroup(
      "springTypes",
      ["単純温泉", "塩化物泉", "炭酸水素塩泉", "硫酸塩泉", "二酸化炭素泉", "含鉄泉", "酸性泉", "含よう素泉", "硫黄泉", "放射能泉"],
      item.spring_types,
      "springTypeOtherCheck",
      "springTypeOther"
    );
    if (Array.isArray(item.indications)) {
      document.querySelectorAll('input[name="indications"]').forEach((el) => {
        el.checked = item.indications.includes(el.value);
      });
      const known = new Set([
        "筋肉痛", "関節痛", "神経痛", "腰痛", "四十肩・五十肩", "打撲・捻挫",
        "冷え症", "血行促進", "慢性的な循環器系不全",
        "疲労回復", "健康増進", "自律神経の調整",
        "胃腸機能の低下", "食欲不振", "慢性的な消化器症状",
        "乾燥肌", "やけど", "切り傷、擦り傷", "慢性的な皮膚疾患",
        "月経に関連する症状", "慢性的な婦人系症状など",
        "慢性的な呼吸器症状など"
      ]);
      const other = item.indications.filter((v) => !known.has(v));
      setValue("indicationsOther", other.join("、"));
    }
    setCheckboxGroup("springColor", ["無色透明", "白濁", "茶褐色"], item.spring_color, "springColorOtherCheck", "springColorOther");
    setCheckboxGroup("springSmell", ["無臭", "硫黄臭", "鉄臭"], item.spring_smell, "springSmellOtherCheck", "springSmellOther");
    setCheckboxGroup(
      "springTexture",
      ["さらさら", "なめらか", "つるつる", "すべすべ", "しっとり", "やわらかい", "まろやか", "とろみがある", "ぬるぬる", "きしきし", "さっぱり", "刺激がある"],
      item.spring_texture,
      "springTextureOtherCheck",
      "springTextureOther"
    );
    setRadioValue("sourceFreeFlow", item.source_free_flow);
    setRadioValue("springDilution", item.spring_dilution);
    setRadioValue("springHeating", item.spring_heating);
    setRadioValue("springCirculation", item.spring_circulation);
    setRadioValue("springDisinfection", item.spring_disinfection);
    setValue("springUsageNote", item.spring_usage_note);
    setValue("springTemperature", item.spring_temperature);
    setValue("sourceTemperature", item.source_temperature);
    setValue("springPh", item.spring_ph);
    setValue("springSourceName", item.spring_source_name);
    setValue("springOpenYear", item.spring_open_year);
    setValue("springOpenYearNote", item.spring_open_year_note);
    setRadioValue("springAnalysis", item.spring_analysis);
    setDateValue("springAnalysis", item.spring_analysis_date);
    setRadioValue("legionellaTest", item.legionella_test);
    setDateValue("legionella", item.legionella_test_date);
    setRadioValue("legionellaResult", item.legionella_result);
    setCheckboxGroup(
      "springInfoSource",
      ["施設掲示", "温泉成分分析書", "施設公式サイト", "自治体・公的機関"],
      item.spring_info_source,
      "springInfoSourceOtherCheck",
      "springInfoSourceOther"
    );
    setDateValue("springInfoCheck", item.spring_info_check_date);
    setRadioValue("childMixedBathing", item.child_mixed_bathing);
    setRadioValue("childAgeLimit", item.child_age_limit);
    setRadioValue("childGenderLimit", item.child_gender_limit);
    setValue("childBoyAgeLimit", item.child_boy_age_limit);
    setValue("childGirlAgeLimit", item.child_girl_age_limit);
    setValue("childMixedBathingNote", item.child_mixed_bathing_note);
    setCheckboxGroup(
      "childInfoSource",
      ["施設掲示", "施設公式サイト", "自治体・公的機関"],
      item.child_info_source,
      "childInfoSourceOtherCheck",
      "childInfoSourceOther"
    );
    setDateValue("childInfoCheck", item.child_info_check_date);

    setRadioValue("maleSaunaFacility", item.sauna_facility_male);
    if (item.sauna_facility_suspended_male) $("maleSaunaFacilitySuspended").checked = true;

    if (["不明", "屋内", "屋外", "両方設置", "なし"].includes(item.sauna_facility_location_male)) {
      setRadioValue("maleSaunaFacilityLocation", item.sauna_facility_location_male);
    } else if (item.sauna_facility_location_male) {
      setRadioValue("maleSaunaFacilityLocation", "その他");
      setValue("maleSaunaFacilityLocationOther", item.sauna_facility_location_male);
      $("maleSaunaFacilityLocationOther")?.classList.remove("hidden");
    }

    setRadioValue("maleSaunaHoursType", item.sauna_hours_type_male);
    if (item.sauna_hours_type_male === "利用時間あり") {
      $("maleSaunaHoursWrap")?.classList.remove("hidden");
    }
    setTimeValue("saunaHoursWeekdayOpen", item.sauna_hours_weekday_open_male);
    setTimeValue("saunaHoursWeekdayClose", item.sauna_hours_weekday_close_male);
    setTimeValue("saunaHoursSaturdayOpen", item.sauna_hours_saturday_open_male);
    setTimeValue("saunaHoursSaturdayClose", item.sauna_hours_saturday_close_male);
    setTimeValue("saunaHoursSundayOpen", item.sauna_hours_sunday_open_male);
    setTimeValue("saunaHoursSundayClose", item.sauna_hours_sunday_close_male);
    setTimeValue("saunaHoursHolidayOpen", item.sauna_hours_holiday_open_male);
    setTimeValue("saunaHoursHolidayClose", item.sauna_hours_holiday_close_male);

    setCheckboxGroup(
      "maleSaunaTypes",
      ["遠赤外線サウナ", "ドライサウナ", "スチームサウナ", "ミストサウナ", "フィンランド式サウナ（ロウリュ）", "テントサウナ", "個室サウナ", "塩サウナ", "薬草サウナ"],
      item.sauna_types_male,
      "maleSaunaTypesOtherCheck",
      "maleSaunaTypesOther"
    );
    setValue("maleSaunaTempMin", item.sauna_temp_min_male);
    setValue("maleSaunaTempMax", item.sauna_temp_max_male);
    setValue("maleSaunaHumidityMin", item.sauna_humidity_min_male);
    setValue("maleSaunaHumidityMax", item.sauna_humidity_max_male);
    setValue("maleSaunaCapacityNumber", item.sauna_capacity_number_male);
    setValue("maleSaunaCapacityRange", item.sauna_capacity_range_male);
    setRadioValue("maleSaunaThermometer", item.sauna_thermometer_male);
    setRadioValue("maleSaunaClock", item.sauna_clock_male);
    setRadioValue("maleSaunaTwelveMinTimer", item.sauna_twelve_min_timer_male);
    setRadioValue("maleSaunaHourglass", item.sauna_hourglass_male);
    setRadioValue("maleSaunaTv", item.sauna_tv_male);
    setRadioValue("maleSaunaTvRemote", item.sauna_tv_remote_male);
    setRadioValue("maleSaunaEmergencyButton", item.sauna_emergency_button_male);
    setRadioValue("maleSaunaStones", item.sauna_stones_male);

    if (["不明", "電気ストーブ", "薪ストーブ", "ガスストーブ", "遠赤外線ストーブ", "ハイブリッド"].includes(item.sauna_stove_type_male)) {
      setRadioValue("maleSaunaStoveType", item.sauna_stove_type_male);
    } else if (item.sauna_stove_type_male) {
      setRadioValue("maleSaunaStoveType", "その他");
      setValue("maleSaunaStoveTypeOther", item.sauna_stove_type_male);
      $("maleSaunaStoveTypeOther")?.classList.remove("hidden");
    }
    setRadioValue("maleSaunaStoveCountStatus", item.sauna_stove_count_status_male);
    setRadioValue("maleSaunaStoveCountStatus", item.sauna_stove_count_status_male);
    setValue("maleSaunaStoveCount", item.sauna_stove_count_male);
    if (item.sauna_stove_count_status_male === "台数あり") {
      $("maleSaunaStoveCountWrap")?.classList.remove("hidden");
    }
    if (item.sauna_stove_count_status_male === "台数あり") {
      $("maleSaunaStoveCountWrap")?.classList.remove("hidden");
    }
    setValue("maleSaunaStoveBrand", item.sauna_stove_brand_male);

    setRadioValue("maleSaunaMatRental", item.sauna_mat_rental_male);
    setCheckboxGroup(
      "maleSaunaMatType",
      ["ビート板タイプ", "ウレタンタイプ", "ジョイントマットタイプ", "タオル・布製タイプ", "木製・すのこタイプ", "樹脂・ゴム製タイプ"],
      item.sauna_mat_type_male,
      "maleSaunaMatTypeOtherCheck",
      "maleSaunaMatTypeOther"
    );
    setCheckboxGroup(
      "maleSaunaMatPlacement",
      ["サウナ室内に設置", "サウナ室入口前に設置", "浴場内に設置", "浴場入口に設置", "自由に利用可能", "個人用貸し出し", "持参可能", "持参必要", "水洗い場所あり", "消毒スプレーあり"],
      item.sauna_mat_placement_male,
      "maleSaunaMatPlacementOtherCheck",
      "maleSaunaMatPlacementOther"
    );
    setRadioValue("maleSaunaGoodsRental", item.sauna_goods_rental_male);
    setRadioValue("maleSaunaGoodsSale", item.sauna_goods_sale_male);

    setRadioValue("maleSaunaLoyly", item.sauna_loyly_male);
    setCheckboxGroup(
      "maleSaunaLoylyType",
      ["セルフロウリュ", "スタッフロウリュ", "オートロウリュ"],
      item.sauna_loyly_type_male,
      "maleSaunaLoylyTypeOtherCheck",
      "maleSaunaLoylyTypeOther"
    );
    setRadioValue("maleSaunaAromaLoyly", item.sauna_aroma_loyly_male);
    setValue("maleSaunaAromaType", item.sauna_aroma_type_male);
    setRadioValue("maleSaunaAufguss", item.sauna_aufguss_male);
    setRadioValue("maleSaunaLoylyFrequency", item.sauna_loyly_frequency_male);
    setValue("maleSaunaLoylyIntervalMinutes", item.sauna_loyly_interval_minutes_male);
    setValue("maleSaunaLoylyIntervalNote", item.sauna_loyly_interval_note_male);
    setRadioValue("maleSaunaLoylyReservation", item.sauna_loyly_reservation_male);
    setValue("maleSaunaLoylyNote", item.sauna_loyly_note_male);

    if (["不明", "押し引きタイプ", "取っ手を回すタイプ"].includes(item.sauna_door_type_male)) {
      setRadioValue("maleSaunaDoorType", item.sauna_door_type_male);
    } else if (item.sauna_door_type_male) {
      setRadioValue("maleSaunaDoorType", "その他");
      setValue("maleSaunaDoorTypeOther", item.sauna_door_type_male);
      $("maleSaunaDoorTypeOther")?.classList.remove("hidden");
    }
    setRadioValue("maleSaunaExitDirection", item.sauna_exit_direction_male);
    setRadioValue("maleSaunaLightBrightness", item.sauna_light_brightness_male);
    setValue("maleSaunaRoomNote", item.sauna_room_note_male);

    setRadioValue("maleColdBathAvailability", item.cold_bath_availability_male);
    setValue("maleColdBathCount", item.cold_bath_count_male);
    setCheckboxGroup("maleColdBathShape", ["一般的タイプ", "浅めタイプ", "深めタイプ", "壺タイプ", "1人用タイプ", "大型・プール"], item.cold_bath_shape_male, null, null);
    setCheckboxGroup("maleColdBathLocation", ["屋内", "屋外", "両方設置"], item.cold_bath_location_male, null, null);
    setCheckboxGroup("maleColdBathSource", ["水道水", "地下水", "天然水", "井戸水", "不明"], item.cold_bath_source_male, "maleColdBathSourceOtherCheck", "maleColdBathSourceOther");
    setCheckboxGroup("maleColdBathCooling", ["チラー冷却", "自然冷却", "不明"], item.cold_bath_cooling_male, "maleColdBathCoolingOtherCheck", "maleColdBathCoolingOther");
    setCheckboxGroup("maleColdBathFlow", ["なし", "バイブラ", "ジェット", "不明"], item.cold_bath_flow_male, "maleColdBathFlowOtherCheck", "maleColdBathFlowOther");
    setValue("maleColdBathTempMin", item.cold_bath_temp_min_male);
    setValue("maleColdBathTempMax", item.cold_bath_temp_max_male);
    setValue("maleColdBathCapacity", item.cold_bath_capacity_male);
    setValue("maleColdBathDepth", item.cold_bath_depth_male);
    setRadioValue("maleColdShower", item.cold_shower_male);
    setValue("maleColdBathNote", item.cold_bath_note_male);

    setRadioValue("maleOutdoor", item.outdoor_male);
    setCheckboxGroup("maleOutdoorLocation", ["露天エリア", "専用外気浴スペース", "ベランダ・テラス"], item.outdoor_location_male, "maleOutdoorLocationOtherCheck", "maleOutdoorLocationOther");
    setRadioValue("maleIndoorBathing", item.indoor_bathing_male);
    setCheckboxGroup("maleIndoorLocation", ["浴場内エリア", "専用内気浴スペース"], item.indoor_location_male, "maleIndoorLocationOtherCheck", "maleIndoorLocationOther");
    setRadioValue("maleToriToiChair", item.tori_toi_chair_male);
    setValue("maleToriToiChairCount", item.tori_toi_chair_count_male);
    setRadioValue("maleReclineChair", item.recline_chair_male);
    setValue("maleReclineChairCount", item.recline_chair_count_male);
    setRadioValue("maleInfinityChair", item.infinity_chair_male);
    setValue("maleInfinityChairCount", item.infinity_chair_count_male);
    setRadioValue("maleBench", item.bench_male);
    setValue("maleBenchCount", item.bench_count_male);
    setRadioValue("maleDeckChair", item.deck_chair_male);
    setValue("maleDeckChairCount", item.deck_chair_count_male);
    setRadioValue("maleLayingSpace", item.laying_space_male);
    setCheckboxGroup("maleLayingSpaceMaterial", ["畳", "木製"], item.laying_space_material_male, "maleLayingSpaceMaterialOtherCheck", "maleLayingSpaceMaterialOther");
    setValue("maleToriToiOtherNote", item.tori_toi_other_note_male);
    setRadioValue("maleRoofRainProtection", item.roof_rain_protection_male);
    setRadioValue("maleSunShade", item.sun_shade_male);
    setCheckboxGroup("maleScenery", ["山・自然", "海・湖", "街並み", "庭園", "星空"], item.scenery_male, "maleSceneryOtherCheck", "maleSceneryOther");
    setValue("maleOutdoorIndoorNote", item.outdoor_indoor_note_male);
    setRadioValue("femaleSaunaFacility", item.sauna_facility_female);
    if (item.sauna_facility_suspended_female) $("femaleSaunaFacilitySuspended").checked = true;

    if (["不明", "屋内", "屋外", "両方設置", "なし"].includes(item.sauna_facility_location_female)) {
      setRadioValue("femaleSaunaFacilityLocation", item.sauna_facility_location_female);
    } else if (item.sauna_facility_location_female) {
      setRadioValue("femaleSaunaFacilityLocation", "その他");
      setValue("femaleSaunaFacilityLocationOther", item.sauna_facility_location_female);
      $("femaleSaunaFacilityLocationOther")?.classList.remove("hidden");
    }

    setRadioValue("femaleSaunaHoursType", item.sauna_hours_type_female);
    if (item.sauna_hours_type_female === "利用時間あり") {
      $("femaleSaunaHoursWrap")?.classList.remove("hidden");
    }
    setTimeValue("saunaHoursWeekdayOpen", item.sauna_hours_weekday_open_female);
    setTimeValue("saunaHoursWeekdayClose", item.sauna_hours_weekday_close_female);
    setTimeValue("saunaHoursSaturdayOpen", item.sauna_hours_saturday_open_female);
    setTimeValue("saunaHoursSaturdayClose", item.sauna_hours_saturday_close_female);
    setTimeValue("saunaHoursSundayOpen", item.sauna_hours_sunday_open_female);
    setTimeValue("saunaHoursSundayClose", item.sauna_hours_sunday_close_female);
    setTimeValue("saunaHoursHolidayOpen", item.sauna_hours_holiday_open_female);
    setTimeValue("saunaHoursHolidayClose", item.sauna_hours_holiday_close_female);

    setCheckboxGroup(
      "femaleSaunaTypes",
      ["遠赤外線サウナ", "ドライサウナ", "スチームサウナ", "ミストサウナ", "フィンランド式サウナ（ロウリュ）", "テントサウナ", "個室サウナ", "塩サウナ", "薬草サウナ"],
      item.sauna_types_female,
      "femaleSaunaTypesOtherCheck",
      "femaleSaunaTypesOther"
    );
    setValue("femaleSaunaTempMin", item.sauna_temp_min_female);
    setValue("femaleSaunaTempMax", item.sauna_temp_max_female);
    setValue("femaleSaunaHumidityMin", item.sauna_humidity_min_female);
    setValue("femaleSaunaHumidityMax", item.sauna_humidity_max_female);
    setValue("femaleSaunaCapacityNumber", item.sauna_capacity_number_female);
    setValue("femaleSaunaCapacityRange", item.sauna_capacity_range_female);
    setRadioValue("femaleSaunaThermometer", item.sauna_thermometer_female);
    setRadioValue("femaleSaunaClock", item.sauna_clock_female);
    setRadioValue("femaleSaunaTwelveMinTimer", item.sauna_twelve_min_timer_female);
    setRadioValue("femaleSaunaHourglass", item.sauna_hourglass_female);
    setRadioValue("femaleSaunaTv", item.sauna_tv_female);
    setRadioValue("femaleSaunaTvRemote", item.sauna_tv_remote_female);
    setRadioValue("femaleSaunaEmergencyButton", item.sauna_emergency_button_female);
    setRadioValue("femaleSaunaStones", item.sauna_stones_female);

    if (["不明", "電気ストーブ", "薪ストーブ", "ガスストーブ", "遠赤外線ストーブ", "ハイブリッド"].includes(item.sauna_stove_type_female)) {
      setRadioValue("femaleSaunaStoveType", item.sauna_stove_type_female);
    } else if (item.sauna_stove_type_female) {
      setRadioValue("femaleSaunaStoveType", "その他");
      setValue("femaleSaunaStoveTypeOther", item.sauna_stove_type_female);
      $("femaleSaunaStoveTypeOther")?.classList.remove("hidden");
    }
    setRadioValue("femaleSaunaStoveCountStatus", item.sauna_stove_count_status_female);
    setRadioValue("femaleSaunaStoveCountStatus", item.sauna_stove_count_status_female);
    setValue("femaleSaunaStoveCount", item.sauna_stove_count_female);
    if (item.sauna_stove_count_status_female === "台数あり") {
      $("femaleSaunaStoveCountWrap")?.classList.remove("hidden");
    }
    if (item.sauna_stove_count_status_female === "台数あり") {
      $("femaleSaunaStoveCountWrap")?.classList.remove("hidden");
    }
    setValue("femaleSaunaStoveBrand", item.sauna_stove_brand_female);

    setRadioValue("femaleSaunaMatRental", item.sauna_mat_rental_female);
    setCheckboxGroup(
      "femaleSaunaMatType",
      ["ビート板タイプ", "ウレタンタイプ", "ジョイントマットタイプ", "タオル・布製タイプ", "木製・すのこタイプ", "樹脂・ゴム製タイプ"],
      item.sauna_mat_type_female,
      "femaleSaunaMatTypeOtherCheck",
      "femaleSaunaMatTypeOther"
    );
    setCheckboxGroup(
      "femaleSaunaMatPlacement",
      ["サウナ室内に設置", "サウナ室入口前に設置", "浴場内に設置", "浴場入口に設置", "自由に利用可能", "個人用貸し出し", "持参可能", "持参必要", "水洗い場所あり", "消毒スプレーあり"],
      item.sauna_mat_placement_female,
      "femaleSaunaMatPlacementOtherCheck",
      "femaleSaunaMatPlacementOther"
    );
    setRadioValue("femaleSaunaGoodsRental", item.sauna_goods_rental_female);
    setRadioValue("femaleSaunaGoodsSale", item.sauna_goods_sale_female);

    setRadioValue("femaleSaunaLoyly", item.sauna_loyly_female);
    setCheckboxGroup(
      "femaleSaunaLoylyType",
      ["セルフロウリュ", "スタッフロウリュ", "オートロウリュ"],
      item.sauna_loyly_type_female,
      "femaleSaunaLoylyTypeOtherCheck",
      "femaleSaunaLoylyTypeOther"
    );
    setRadioValue("femaleSaunaAromaLoyly", item.sauna_aroma_loyly_female);
    setValue("femaleSaunaAromaType", item.sauna_aroma_type_female);
    setRadioValue("femaleSaunaAufguss", item.sauna_aufguss_female);
    setRadioValue("femaleSaunaLoylyFrequency", item.sauna_loyly_frequency_female);
    setValue("femaleSaunaLoylyIntervalMinutes", item.sauna_loyly_interval_minutes_female);
    setValue("femaleSaunaLoylyIntervalNote", item.sauna_loyly_interval_note_female);
    setRadioValue("femaleSaunaLoylyReservation", item.sauna_loyly_reservation_female);
    setValue("femaleSaunaLoylyNote", item.sauna_loyly_note_female);

    if (["不明", "押し引きタイプ", "取っ手を回すタイプ"].includes(item.sauna_door_type_female)) {
      setRadioValue("femaleSaunaDoorType", item.sauna_door_type_female);
    } else if (item.sauna_door_type_female) {
      setRadioValue("femaleSaunaDoorType", "その他");
      setValue("femaleSaunaDoorTypeOther", item.sauna_door_type_female);
      $("femaleSaunaDoorTypeOther")?.classList.remove("hidden");
    }
    setRadioValue("femaleSaunaExitDirection", item.sauna_exit_direction_female);
    setRadioValue("femaleSaunaLightBrightness", item.sauna_light_brightness_female);
    setValue("femaleSaunaRoomNote", item.sauna_room_note_female);

    setRadioValue("femaleColdBathAvailability", item.cold_bath_availability_female);
    setValue("femaleColdBathCount", item.cold_bath_count_female);
    setCheckboxGroup("femaleColdBathShape", ["一般的タイプ", "浅めタイプ", "深めタイプ", "壺タイプ", "1人用タイプ", "大型・プール"], item.cold_bath_shape_female, null, null);
    setCheckboxGroup("femaleColdBathLocation", ["屋内", "屋外", "両方設置"], item.cold_bath_location_female, null, null);
    setCheckboxGroup("femaleColdBathSource", ["水道水", "地下水", "天然水", "井戸水", "不明"], item.cold_bath_source_female, "femaleColdBathSourceOtherCheck", "femaleColdBathSourceOther");
    setCheckboxGroup("femaleColdBathCooling", ["チラー冷却", "自然冷却", "不明"], item.cold_bath_cooling_female, "femaleColdBathCoolingOtherCheck", "femaleColdBathCoolingOther");
    setCheckboxGroup("femaleColdBathFlow", ["なし", "バイブラ", "ジェット", "不明"], item.cold_bath_flow_female, "femaleColdBathFlowOtherCheck", "femaleColdBathFlowOther");
    setValue("femaleColdBathTempMin", item.cold_bath_temp_min_female);
    setValue("femaleColdBathTempMax", item.cold_bath_temp_max_female);
    setValue("femaleColdBathCapacity", item.cold_bath_capacity_female);
    setValue("femaleColdBathDepth", item.cold_bath_depth_female);
    setRadioValue("femaleColdShower", item.cold_shower_female);
    setValue("femaleColdBathNote", item.cold_bath_note_female);

    setRadioValue("femaleOutdoor", item.outdoor_female);
    setCheckboxGroup("femaleOutdoorLocation", ["露天エリア", "専用外気浴スペース", "ベランダ・テラス"], item.outdoor_location_female, "femaleOutdoorLocationOtherCheck", "femaleOutdoorLocationOther");
    setRadioValue("femaleIndoorBathing", item.indoor_bathing_female);
    setCheckboxGroup("femaleIndoorLocation", ["浴場内エリア", "専用内気浴スペース"], item.indoor_location_female, "femaleIndoorLocationOtherCheck", "femaleIndoorLocationOther");
    setRadioValue("femaleToriToiChair", item.tori_toi_chair_female);
    setValue("femaleToriToiChairCount", item.tori_toi_chair_count_female);
    setRadioValue("femaleReclineChair", item.recline_chair_female);
    setValue("femaleReclineChairCount", item.recline_chair_count_female);
    setRadioValue("femaleInfinityChair", item.infinity_chair_female);
    setValue("femaleInfinityChairCount", item.infinity_chair_count_female);
    setRadioValue("femaleBench", item.bench_female);
    setValue("femaleBenchCount", item.bench_count_female);
    setRadioValue("femaleDeckChair", item.deck_chair_female);
    setValue("femaleDeckChairCount", item.deck_chair_count_female);
    setRadioValue("femaleLayingSpace", item.laying_space_female);
    setCheckboxGroup("femaleLayingSpaceMaterial", ["畳", "木製"], item.laying_space_material_female, "femaleLayingSpaceMaterialOtherCheck", "femaleLayingSpaceMaterialOther");
    setValue("femaleToriToiOtherNote", item.tori_toi_other_note_female);
    setRadioValue("femaleRoofRainProtection", item.roof_rain_protection_female);
    setRadioValue("femaleSunShade", item.sun_shade_female);
    setCheckboxGroup("femaleScenery", ["山・自然", "海・湖", "街並み", "庭園", "星空"], item.scenery_female, "femaleSceneryOtherCheck", "femaleSceneryOther");
    setValue("femaleOutdoorIndoorNote", item.outdoor_indoor_note_female);

    setValue("maleShowerCount", item.shower_count_male);
    setCheckboxGroup("maleShowerType", ["押すタイプ", "レバータイプ", "不明"], item.shower_type_male, "maleShowerTypeOtherCheck", "maleShowerTypeOther");
    setValue("maleShowerHeadInfo", item.shower_head_info_male);
    setRadioValue("maleShowerFaucet", item.shower_faucet_male);
    setRadioValue("maleShowerBooth", item.shower_booth_male);
    setRadioValue("maleWashAreaDivider", item.wash_area_divider_male);
    setRadioValue("maleBathTrashBin", item.bath_trash_bin_male);
    setRadioValue("malePreRinseWater", item.pre_rinse_water_male);
    setValue("maleShowerNote", item.shower_note_male);

    setRadioValue("maleShampooConditioner", item.shampoo_conditioner_male);
    setRadioValue("maleBodySoap", item.body_soap_male);
    setRadioValue("maleSoap", item.soap_male);
    setRadioValue("maleFaceWash", item.face_wash_male);
    setRadioValue("maleCleansing", item.cleansing_male);
    setRadioValue("maleBasin", item.basin_male);
    setRadioValue("maleBathChair", item.bath_chair_male);
    setRadioValue("maleShowerChair", item.shower_chair_male);
    populateRentalItems("maleRentalRows", item.rental_items_male);
    setRadioValue("maleDryerStatus", item.dryer_status_male);
    setValue("maleDryerCount", item.dryer_count_male);
    setRadioValue("maleDryerFee", item.dryer_fee_male);
    setValue("maleDryerBrand", item.dryer_brand_male);
    setRadioValue("maleDryerBringOwn", item.dryer_bring_own_male);
    setRadioValue("maleTissue", item.tissue_male);
    setRadioValue("maleCottonSwab", item.cotton_swab_male);
    setRadioValue("maleCosmetics", item.cosmetics_male);
    setRadioValue("maleHairTie", item.hair_tie_male);
    setRadioValue("malePowderRoom", item.powder_room_male);
    setRadioValue("maleVanity", item.vanity_male);
    setRadioValue("maleWaterCooler", item.water_cooler_male);
    setRadioValue("maleFan", item.fan_male);
    setRadioValue("maleScale", item.scale_male);
    setRadioValue("maleBloodPressureMonitor", item.blood_pressure_monitor_male);
    setRadioValue("maleTrashBin", item.trash_bin_male);
    setRadioValue("maleLockerRoomChair", item.locker_room_chair_male);
    setRadioValue("maleBabyChair", item.baby_chair_male);
    setRadioValue("maleBabyBed", item.baby_bed_male);
    setValue("maleAmenityNote", item.amenity_note_male);
    setValue("femaleShowerCount", item.shower_count_female);
    setCheckboxGroup("femaleShowerType", ["押すタイプ", "レバータイプ", "不明"], item.shower_type_female, "femaleShowerTypeOtherCheck", "femaleShowerTypeOther");
    setValue("femaleShowerHeadInfo", item.shower_head_info_female);
    setRadioValue("femaleShowerFaucet", item.shower_faucet_female);
    setRadioValue("femaleShowerBooth", item.shower_booth_female);
    setRadioValue("femaleWashAreaDivider", item.wash_area_divider_female);
    setRadioValue("femaleBathTrashBin", item.bath_trash_bin_female);
    setRadioValue("femalePreRinseWater", item.pre_rinse_water_female);
    setValue("femaleShowerNote", item.shower_note_female);

    setRadioValue("femaleShampooConditioner", item.shampoo_conditioner_female);
    setRadioValue("femaleBodySoap", item.body_soap_female);
    setRadioValue("femaleSoap", item.soap_female);
    setRadioValue("femaleFaceWash", item.face_wash_female);
    setRadioValue("femaleCleansing", item.cleansing_female);
    setRadioValue("femaleBasin", item.basin_female);
    setRadioValue("femaleBathChair", item.bath_chair_female);
    setRadioValue("femaleShowerChair", item.shower_chair_female);
    populateRentalItems("femaleRentalRows", item.rental_items_female);
    setRadioValue("femaleDryerStatus", item.dryer_status_female);
    setValue("femaleDryerCount", item.dryer_count_female);
    setRadioValue("femaleDryerFee", item.dryer_fee_female);
    setValue("femaleDryerBrand", item.dryer_brand_female);
    setRadioValue("femaleDryerBringOwn", item.dryer_bring_own_female);
    setRadioValue("femaleTissue", item.tissue_female);
    setRadioValue("femaleCottonSwab", item.cotton_swab_female);
    setRadioValue("femaleCosmetics", item.cosmetics_female);
    setRadioValue("femaleHairTie", item.hair_tie_female);
    setRadioValue("femalePowderRoom", item.powder_room_female);
    setRadioValue("femaleVanity", item.vanity_female);
    setRadioValue("femaleWaterCooler", item.water_cooler_female);
    setRadioValue("femaleFan", item.fan_female);
    setRadioValue("femaleScale", item.scale_female);
    setRadioValue("femaleBloodPressureMonitor", item.blood_pressure_monitor_female);
    setRadioValue("femaleTrashBin", item.trash_bin_female);
    setRadioValue("femaleLockerRoomChair", item.locker_room_chair_female);
    setRadioValue("femaleBabyChair", item.baby_chair_female);
    setRadioValue("femaleBabyBed", item.baby_bed_female);
    setValue("femaleAmenityNote", item.amenity_note_female);

    // 🔐 ロッカー
    setValue("maleLockerCount", item.locker_count_male);
    setCheckboxGroup(
      "maleLockerKeyType",
      ["不明", "鍵", "リストバンド", "靴箱の鍵と交換方式", "コイン式（有料）", "コイン返却式", "IC・電子キー", "暗証番号", "ダイヤル", "施錠なし（カゴ・棚）"],
      item.locker_key_type_male,
      "maleLockerKeyTypeOtherCheck",
      "maleLockerKeyTypeOther"
    );
    setCheckboxGroup(
      "maleLockerWristbandType",
      ["不明", "ゴム・シリコン型", "スパイラル型", "マジックテープ型", "バックル型"],
      item.locker_wristband_type_male,
      "maleLockerWristbandTypeOtherCheck",
      "maleLockerWristbandTypeOther"
    );
    setCheckboxGroup(
      "maleLockerWristbandUse",
      ["不明", "なし", "ロッカーキー", "館内決済", "入退館管理"],
      item.locker_wristband_use_male,
      "maleLockerWristbandUseOtherCheck",
      "maleLockerWristbandUseOther"
    );
    setCheckboxGroup(
      "maleLockerSize",
      ["正方形タイプ", "縦長タイプ", "通常型タイプ", "小型タイプ", "大型タイプ", "キャリーケース対応タイプ", "かごタイプ", "棚タイプ"],
      item.locker_size_male,
      "maleLockerSizeOtherCheck",
      "maleLockerSizeOther"
    );
    setRadioValue("maleLockerDivider", item.locker_divider_male);
    setRadioValue("maleLockerHanger", item.locker_hanger_male);
    setRadioValue("maleLockerSmallItemBox", item.locker_small_item_box_male);
    setRadioValue("maleLockerValuables", item.locker_valuables_male);
    setRadioValue("maleLockerRental", item.locker_rental_male);
    setRadioValue("maleLockerSuitcase", item.locker_suitcase_male);
    setValue("maleLockerNote", item.locker_note_male);

    // 👟 靴箱
    setValue("maleShoeboxCount", item.shoebox_count_male);
    setCheckboxGroup(
      "maleShoeboxType",
      ["不明", "個別靴箱", "オープン棚", "靴カゴ", "大型靴箱", "車いす・大型荷物対応スペース"],
      item.shoebox_type_male,
      "maleShoeboxTypeOtherCheck",
      "maleShoeboxTypeOther"
    );
    setCheckboxGroup(
      "maleShoeboxKeyType",
      ["不明", "鍵", "リストバンド", "コイン式", "コイン返却式", "IC・電子キー", "暗証番号", "ダイヤル", "施錠なし"],
      item.shoebox_key_type_male,
      "maleShoeboxKeyTypeOtherCheck",
      "maleShoeboxKeyTypeOther"
    );
    setRadioValue("maleShoeboxFee", item.shoebox_fee_male);
    setValue("maleShoeboxNote", item.shoebox_note_male);
    setValue("femaleLockerCount", item.locker_count_female);
    setCheckboxGroup(
      "femaleLockerKeyType",
      ["不明", "鍵", "リストバンド", "靴箱の鍵と交換方式", "コイン式（有料）", "コイン返却式", "IC・電子キー", "暗証番号", "ダイヤル", "施錠なし（カゴ・棚）"],
      item.locker_key_type_female,
      "femaleLockerKeyTypeOtherCheck",
      "femaleLockerKeyTypeOther"
    );
    setCheckboxGroup(
      "femaleLockerWristbandType",
      ["不明", "ゴム・シリコン型", "スパイラル型", "マジックテープ型", "バックル型"],
      item.locker_wristband_type_female,
      "femaleLockerWristbandTypeOtherCheck",
      "femaleLockerWristbandTypeOther"
    );
    setCheckboxGroup(
      "femaleLockerWristbandUse",
      ["不明", "なし", "ロッカーキー", "館内決済", "入退館管理"],
      item.locker_wristband_use_female,
      "femaleLockerWristbandUseOtherCheck",
      "femaleLockerWristbandUseOther"
    );
    setCheckboxGroup(
      "femaleLockerSize",
      ["正方形タイプ", "縦長タイプ", "通常型タイプ", "小型タイプ", "大型タイプ", "キャリーケース対応タイプ", "かごタイプ", "棚タイプ"],
      item.locker_size_female,
      "femaleLockerSizeOtherCheck",
      "femaleLockerSizeOther"
    );
    setRadioValue("femaleLockerDivider", item.locker_divider_female);
    setRadioValue("femaleLockerHanger", item.locker_hanger_female);
    setRadioValue("femaleLockerSmallItemBox", item.locker_small_item_box_female);
    setRadioValue("femaleLockerValuables", item.locker_valuables_female);
    setRadioValue("femaleLockerRental", item.locker_rental_female);
    setRadioValue("femaleLockerSuitcase", item.locker_suitcase_female);
    setValue("femaleLockerNote", item.locker_note_female);

    // 👟 靴箱
    setValue("femaleShoeboxCount", item.shoebox_count_female);
    setCheckboxGroup(
      "femaleShoeboxType",
      ["不明", "個別靴箱", "オープン棚", "靴カゴ", "大型靴箱", "車いす・大型荷物対応スペース"],
      item.shoebox_type_female,
      "femaleShoeboxTypeOtherCheck",
      "femaleShoeboxTypeOther"
    );
    setCheckboxGroup(
      "femaleShoeboxKeyType",
      ["不明", "鍵", "リストバンド", "コイン式", "コイン返却式", "IC・電子キー", "暗証番号", "ダイヤル", "施錠なし"],
      item.shoebox_key_type_female,
      "femaleShoeboxKeyTypeOtherCheck",
      "femaleShoeboxKeyTypeOther"
    );
    setRadioValue("femaleShoeboxFee", item.shoebox_fee_female);
    setValue("femaleShoeboxNote", item.shoebox_note_female);

    // 🚻 トイレ・バリアフリー
    setRadioValue("toiletLocationLobby", item.toilet_location_lobby);
    setRadioValue("toiletMensChangingRoom", item.toilet_mens_changing_room);
    setRadioValue("toiletWomensChangingRoom", item.toilet_womens_changing_room);
    setValue("toiletLocationOther", item.toilet_location_other);
    setCheckboxGroup(
      "toiletTypes",
      ["不明", "洋式トイレ", "和式トイレ", "小便器"],
      item.toilet_types,
      "toiletTypesOtherCheck",
      "toiletTypesOther"
    );
    setRadioValue("toiletAccessible", item.toilet_accessible);
    setRadioValue("toiletWheelchair", item.toilet_wheelchair);
    setRadioValue("toiletOstomate", item.toilet_ostomate);
    setRadioValue("toiletDiaperTable", item.toilet_diaper_table);
    setRadioValue("toiletBabyChairInToilet", item.toilet_baby_chair_in_toilet);
    setRadioValue("toiletSlope", item.toilet_slope);
    setRadioValue("toiletElevator", item.toilet_elevator);
    setValue("toiletBarrierFreeNote", item.toilet_barrier_free_note);

    // 🍴 お食事処
    setRadioValue("restaurantStatus", item.restaurant_status);
    setCheckboxGroup(
      "restaurantTypes",
      ["お食事処・レストラン", "食堂", "居酒屋", "カフェ", "軽食・売店", "ドリンクコーナー", "フードコート", "不明", "なし"],
      item.restaurant_types,
      "restaurantTypesOtherCheck",
      "restaurantTypesOther"
    );
    setValue("restaurantFeature", item.restaurant_feature);
    setRadioValue("restaurantHoursType", item.restaurant_hours_type);
    populateHoursRangeRows("restaurantAdditionalHoursRows", item.restaurant_additional_hours);
    if (item.restaurant_hours_type === "営業時間あり") {
      $("restaurantHoursWrap")?.classList.remove("hidden");
    }
    setTimeValue("restaurantOpenTime", item.restaurant_open_time);
    setTimeValue("restaurantCloseTime", item.restaurant_close_time);
    setTimeValue("restaurantLastOrder", item.restaurant_last_order);
    setCheckboxGroup(
      "restaurantPayment",
      ["現金", "クレジットカード", "電子マネー", "QRコード決済", "食券制", "リストバンド決済"],
      item.restaurant_payment,
      "restaurantPaymentOtherCheck",
      "restaurantPaymentOther"
    );
    setCheckboxGroup(
      "restaurantOtherInfo",
      ["アルコール提供あり", "テイクアウト可能", "子ども向けメニューあり", "ベジタリアン対応", "座席あり", "個室・座敷あり"],
      item.restaurant_other_info,
      "restaurantOtherInfoOtherCheck",
      "restaurantOtherInfoOther"
    );
    setValue("restaurantNote", item.restaurant_note);

    // 🛋 休憩スペース
    setRadioValue("restSpaceStatus", item.rest_space_status);
    setCheckboxGroup(
      "restSpaceType",
      ["リクライニングチェア", "休憩ラウンジ", "畳・座敷", "仮眠スペース", "ソファスペース", "リラックスルーム", "ワークスペース", "テレビ付き", "雑誌・本あり", "おもちゃあり", "不明", "なし"],
      item.rest_space_type,
      "restSpaceTypeOtherCheck",
      "restSpaceTypeOther"
    );
    setRadioValue("restSpaceCondition", item.rest_space_condition);
    setRadioValue("restSpaceFeeType", item.rest_space_fee_type);
    if (item.rest_space_fee_type === "その他") {
      $("restSpaceFeeTypeOtherText")?.classList.remove("hidden");
    }
    if (item.rest_space_fee_type === "別料金") {
      $("restSpaceFeeAmountWrap")?.classList.remove("hidden");
    }
    setValue("restSpaceFeeAmount", item.rest_space_fee_amount);
    setRadioValue("restSpaceHoursType", item.rest_space_hours_type);
    if (item.rest_space_hours_type === "利用時間あり") {
      $("restSpaceHoursWrap")?.classList.remove("hidden");
    }
    setTimeValue("restSpaceHoursOpen", item.rest_space_hours_open);
    setTimeValue("restSpaceHoursClose", item.rest_space_hours_close);
    setRadioValue("restSpacePerPersonType", item.rest_space_per_person_type);
    if (item.rest_space_per_person_type === "時間指定") {
      $("restSpacePerPersonWrap")?.classList.remove("hidden");
    }
    setValue("restSpacePerPersonMinutes", item.rest_space_per_person_minutes);
    setValue("restSpaceNote", item.rest_space_note);

    // 💆‍♀️ マッサージ・リラクゼーション
    setRadioValue("massageStatus", item.massage_status);
    setCheckboxGroup(
      "massageTypes",
      ["マッサージ", "ボディケア・もみほぐし", "フットケア・足つぼ", "アカスリ", "ヘッドスパ", "エステ・美容", "整体・ストレッチ", "リラクゼーションサロン", "不明", "なし"],
      item.massage_types,
      "massageTypesOtherCheck",
      "massageTypesOther"
    );
    const massageFeeRows = $("massageFeeRows");
    if (massageFeeRows) {
      massageFeeRows.innerHTML = "";
      if (Array.isArray(item.massage_menu_fees) && item.massage_menu_fees.length) {
        item.massage_menu_fees.forEach((f) =>
          addFeeRow3("massageFeeRows", f.name || "", f.minutes ?? "", f.price ?? "", { focus: false })
        );
      }
    }
    setRadioValue("massageHoursType", item.massage_hours_type);
    if (item.massage_hours_type === "営業時間あり") {
      $("massageHoursWrap")?.classList.remove("hidden");
    }
    setTimeValue("massageHoursOpen", item.massage_hours_open);
    setTimeValue("massageHoursClose", item.massage_hours_close);
    populateHoursRangeRows("massageAdditionalHoursRows", item.massage_additional_hours);
    setRadioValue("massageChairStatus", item.massage_chair_status);
    setValue("massageChairCount", item.massage_chair_count);
    setValue("massageChairMinutes", item.massage_chair_minutes);
    setValue("massageChairPrice", item.massage_chair_price);
    setValue("massageNote", item.massage_note);

    // 💬 レンタル・コワーキングスペース
    setRadioValue("rentalSpaceStatus", item.rental_space_status);
    setRadioValue("coworkingSpaceStatus", item.coworking_space_status);
    setCheckboxGroup(
      "coworkingFeatures",
      ["デスク・作業スペースあり", "Wi-Fiあり", "電源あり", "モニターあり", "通話可能", "個人ブースあり"],
      item.coworking_features,
      "coworkingFeaturesOtherCheck",
      "coworkingFeaturesOther"
    );
    setValue("coworkingNote", item.coworking_note);

    // 🥤 自動販売機
    setRadioValue("vendingMachineStatus", item.vending_machine_status);
    setCheckboxGroup(
      "vendingMachineTypes",
      ["ペットボトル飲料", "ビン飲料", "アイス", "軽食"],
      item.vending_machine_types,
      "vendingMachineTypesOtherCheck",
      "vendingMachineTypesOther"
    );
    setCheckboxGroup(
      "vendingMachineLocation",
      ["更衣室内", "休憩施設内", "ロビー", "屋外"],
      item.vending_machine_location,
      "vendingMachineLocationOtherCheck",
      "vendingMachineLocationOther"
    );
    setRadioValue("recycleBoxStatus", item.recycle_box_status);
    setValue("vendingMachineNote", item.vending_machine_note);

    // 🛍 売店コーナー
    setRadioValue("shopStatus", item.shop_status);
    setCheckboxGroup(
      "shopItems",
      ["入浴用品", "サウナ用品", "衣類・館内着", "履き物", "タオル・バスタオル", "化粧品・スキンケア用品", "軽食・お菓子", "お弁当・食品", "飲料", "アイス・スイーツ", "地元の食材", "お土産・特産品", "雑貨・グッズ", "その他の日用品"],
      item.shop_items,
      "shopItemsOtherCheck",
      "shopItemsOther"
    );
    setRadioValue("shopHoursType", item.shop_hours_type);
    if (item.shop_hours_type === "利用時間あり") {
      $("shopHoursWrap")?.classList.remove("hidden");
    }
    setTimeValue("shopHoursOpen", item.shop_hours_open);
    setTimeValue("shopHoursClose", item.shop_hours_close);
    populateHoursRangeRows("shopAdditionalHoursRows", item.shop_additional_hours);
    setRadioValue("convenienceStoreStatus", item.convenience_store_status);
    setRadioValue("convenienceStoreHoursType", item.convenience_store_hours_type);
    if (item.convenience_store_hours_type === "営業時間あり") {
      $("convenienceStoreHoursWrap")?.classList.remove("hidden");
    }
    populateHoursRangeRows("convenienceStoreHoursRows", item.convenience_store_hours);
    setCheckboxGroup(
      "shopPayment",
      ["現金", "クレジットカード", "電子マネー", "QRコード決済", "リストバンド決済"],
      item.shop_payment,
      "shopPaymentOtherCheck",
      "shopPaymentOther"
    );
    setValue("shopNote", item.shop_note);

    // その他の各種施設
    setRadioValue("accommodationStatus", item.accommodation_status);
    setRadioValue("poolFacilityStatus", item.pool_facility_status);
    setRadioValue("gameCornerStatus", item.game_corner_status);
    setRadioValue("kidsCornerStatus", item.kids_corner_status);
    setRadioValue("outdoorFacilityStatus", item.outdoor_facility_status);
    setRadioValue("footBathStatus", item.foot_bath_status);
    setRadioValue("ganbanyokuStatus", item.ganbanyoku_status);
    setRadioValue("coinLaundryStatus", item.coin_laundry_status);
    setRadioValue("springTakeawayStatus", item.spring_takeaway_status);
    setRadioValue("onsenTamagoStatus", item.onsen_tamago_status);
    setRadioValue("wifiFacility", item.wifi_facility);
    if (item.wifi_facility === "有料") {
      $("wifiFeeWrap")?.classList.remove("hidden");
    }
    setValue("wifiFeeMinutes", item.wifi_fee_minutes);
    setValue("wifiFeePrice", item.wifi_fee_price);
    setRadioValue("chargingSpot", item.charging_spot);
    if (item.charging_spot === "有料") {
      $("chargingFeeWrap")?.classList.remove("hidden");
    }
    setValue("chargingFeeMinutes", item.charging_fee_minutes);
    setValue("chargingFeePrice", item.charging_fee_price);
    setRadioValue("aedFacilityStatus", item.aed_facility_status);
    setRadioValue("firstAidRoomStatus", item.first_aid_room_status);
    setValue("otherFacilityNote", item.other_facility_note);

    // 🅿️ 駐車場・駐輪場
    setRadioValue("parkingStatus", item.parking_status);
    setValue("parkingCapacity", item.parking_capacity);
    setRadioValue("parkingFeeType", item.parking_fee_type);
    if (item.parking_fee_type === "有料") {
      $("parkingFeeAmountWrap")?.classList.remove("hidden");
    }
    setValue("parkingFeeAmount", item.parking_fee_amount);
    if (Array.isArray(item.parking_conditions)) {
      const knownConditions = ["施設利用者無料", "サービス券あり", "駐車券タイプ", "ナンバー読み取りタイプ"];
      document.querySelectorAll('input[name="parkingConditions"]').forEach((el) => {
        el.checked = item.parking_conditions.includes(el.value);
      });
      const freeHoursEntry = item.parking_conditions.find((v) => /^\d+時間無料$/.test(v));
      if (freeHoursEntry) {
        $("parkingFreeHoursCheck").checked = true;
        setValue("parkingFreeHours", freeHoursEntry.replace("時間無料", ""));
      }
      const otherConditions = item.parking_conditions.filter(
        (v) => !knownConditions.includes(v) && !/^\d+時間無料$/.test(v)
      );
      if (otherConditions.length) {
        $("parkingConditionsOtherCheck").checked = true;
        $("parkingConditionsOther")?.classList.remove("hidden");
        setValue("parkingConditionsOther", otherConditions.join("、"));
      }
    }
    setCheckboxGroup(
      "parkingTypes",
      ["平面駐車場", "立体駐車場", "地下駐車場", "提携駐車場", "施設共用駐車場"],
      item.parking_types,
      "parkingTypesOtherCheck",
      "parkingTypesOther"
    );
    setCheckboxGroup(
      "parkingAccessible",
      ["車椅子対応駐車スペース", "大型車駐車スペース", "バス駐車スペース"],
      item.parking_accessible,
      "parkingAccessibleOtherCheck",
      "parkingAccessibleOther"
    );
    setRadioValue("parkingTemporary", item.parking_temporary);
    setRadioValue("motorcycleParking", item.motorcycle_parking);
    setRadioValue("bicycleParking", item.bicycle_parking);
    setValue("parkingNote", item.parking_note);

    // 📢 お知らせ・イベント情報
    setValue("noticeInfo", item.notice_info);
    setValue("eventInfo", item.event_info);

    // ⭐️ ユーザー情報
    setDateValue("lastVisitDate", item.last_visit_date);
    setDateValue("lastInfoCheckDate", item.last_info_check_date);
    setCheckboxGroup(
      "userInfoSource",
      ["公式サイト", "温泉情報サイト", "自治体公式サイト"],
      item.user_info_source,
      "userInfoSourceOtherCheck",
      "userInfoSourceOther"
    );

    // 📍 位置情報・メモ

    setValue("lat", item.lat);
    setValue("lng", item.lng);
    setValue("googleMapsUrl", item.google_maps_url);
    setValue("note", item.note);

    // 男女の浴場情報等が完全に一致していれば共通モード、異なっていれば男女別モードにする
    if ($("genderCommonModeToggle")) {
      $("genderCommonModeToggle").checked = detectGenderCommonModeFromData();
    }
    applyGenderCommonModeUI();
  }

  // ---------------------------------------------------------
  // LocalStorage
  // ---------------------------------------------------------

  function getLocalData() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (!raw) return [];

      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error("LocalStorage読込エラー:", error);
      return [];
    }
  }

  function saveLocalData(list) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  }

  function addLocalData(item) {
    const list = getLocalData();

    item.id =
      item.id ||
      `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    list.unshift(item);
    saveLocalData(list);

    return item;
  }

  // ---------------------------------------------------------
  // Supabase
  // ---------------------------------------------------------

  async function loadSupabaseData() {
    if (!supabaseClient) return null;

    const { data, error } = await supabaseClient
      .from(TABLE_NAME)
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase読込エラー:", error);
      throw error;
    }

    return Array.isArray(data) ? data : [];
  }

  // Supabaseの現行スキーマに実在する列だけを一覧化しておき、
  // 過去バージョンのローカルデータ等に含まれる廃止済みの項目名を
  // 送信時に自動で取り除けるようにする。
  const KNOWN_COLUMNS = new Set([
    "is_24_hours",
    "temp_closed_detail",
    "weekday_hours_overrides",
    "overnight_open_time", "overnight_close_time", "overnight_last_entry", "overnight_days", "overnight_additional_hours",
    "morning_bath_open_time", "morning_bath_close_time", "morning_bath_last_entry", "morning_bath_days", "morning_bath_additional_hours",
    "other_hours_label", "other_hours_open_time", "other_hours_close_time", "other_hours_last_entry", "other_hours_days", "other_hours_additional_hours",
    "closed_nth_weeks", "closed_nth_weekday", "closed_monthly_dates",
    "closed_irregular", "closed_calendar_based", "closed_holiday_rule", "closed_day_pattern_note",
    "access_method", "accommodation_status", "address", "aed_facility_status", 
    "amenity_note_female", "amenity_note_male", "area", "baby_bed_female", 
    "baby_bed_male", "baby_chair_female", "baby_chair_male", "basin_female", "basin_male", 
    "bath_anteroom_female", "bath_anteroom_male", "bath_chair_female", "bath_chair_male", 
    "bath_event_detail_female", "bath_event_detail_male", "bath_event_female", "bath_event_male", 
    "bath_fees", "ticket_fees", "disability_fees", "disability_fee_note", "member_benefits", "special_coupons", "discount_supplementary_note", "bath_function_female", "bath_function_male", "bath_handrail_female", 
    "bath_handrail_male", "bath_location_female", "bath_location_male", "bath_note_female", 
    "bath_note_male", "bath_shape_female", "bath_shape_male", "bath_toys_detail_female", 
    "bath_toys_detail_male", "bath_toys_female", "bath_toys_male", "bath_trash_bin_female", 
    "bath_trash_bin_male", "bench_count_female", "bench_count_male", "bench_female", "bench_male", 
    "bicycle_parking", "blood_pressure_monitor_female", "blood_pressure_monitor_male", 
    "body_soap_female", "body_soap_male", "business_type", "charging_fee_minutes", 
    "charging_fee_price", "charging_spot", "child_age_limit", "child_boy_age_limit", 
    "child_gender_limit", "child_girl_age_limit", "child_info_check_date", "child_info_source", 
    "child_mixed_bathing", "child_mixed_bathing_note", "cleansing_female", "cleansing_male", 
    "close_time", "closed_days", "closed_days_note", "coin_laundry_status", 
    "cold_bath_availability_female", "cold_bath_availability_male", "cold_bath_capacity_female", 
    "cold_bath_capacity_male", "cold_bath_cooling_female", "cold_bath_cooling_male", 
    "cold_bath_count_female", "cold_bath_count_male", "cold_bath_depth_female", 
    "cold_bath_depth_male", "cold_bath_flow_female", "cold_bath_flow_male", 
    "cold_bath_location_female", "cold_bath_location_male", "cold_bath_note_female", 
    "cold_bath_note_male", "cold_bath_shape_female", "cold_bath_shape_male", 
    "cold_bath_source_female", "cold_bath_source_male", "cold_bath_temp_max_female", 
    "cold_bath_temp_max_male", "cold_bath_temp_min_female", "cold_bath_temp_min_male", 
    "cold_shower_female", "cold_shower_male", "cosmetics_female", "cosmetics_male", 
    "cotton_swab_female", "cotton_swab_male", "coworking_features", "coworking_note", 
    "coworking_space_status", "created_at", "deck_chair_count_female", "deck_chair_count_male", 
    "deck_chair_female", "deck_chair_male", "dryer_brand_female", "dryer_brand_male", 
    "dryer_bring_own_female", "dryer_bring_own_male", "dryer_count_female", "dryer_count_male", 
    "dryer_fee_female", "dryer_fee_male", "dryer_status_female", "dryer_status_male", "event_info", 
    "face_wash_female", "face_wash_male", "facebook", "fan_female", "fan_male", 
    "first_aid_room_status", "foot_bath_status", "game_corner_status", "ganbanyoku_status", 
    "google_maps_url", "hair_tie_female", "hair_tie_male", "hours_note", "id", "indications", 
    "indoor_bathing_female", "indoor_bathing_male", "indoor_location_female", 
    "indoor_location_male", "infinity_chair_count_female", "infinity_chair_count_male", 
    "infinity_chair_female", "infinity_chair_male", "instagram", "is_closed", "is_temp_closed", 
    "kids_corner_status", "last_entry", "last_info_check_date", "last_visit_date", "lat", 
    "laying_space_female", "laying_space_male", "laying_space_material_female", 
    "laying_space_material_male", "legionella_result", "legionella_test", "legionella_test_date", 
    "lng", "locker_count_female", "locker_count_male", "locker_divider_female", 
    "locker_divider_male", "locker_hanger_female", "locker_hanger_male", "locker_key_type_female", 
    "locker_key_type_male", "locker_note_female", "locker_note_male", "locker_rental_female", 
    "locker_rental_male", "locker_room_chair_female", "locker_room_chair_male", 
    "locker_size_female", "locker_size_male", "locker_small_item_box_female", 
    "locker_small_item_box_male", "locker_suitcase_female", "locker_suitcase_male", 
    "locker_valuables_female", "locker_valuables_male", "locker_wristband_type_female", 
    "locker_wristband_type_male", "locker_wristband_use_female", "locker_wristband_use_male", 
    "massage_chair_count", "massage_chair_minutes", "massage_chair_price", "massage_chair_status", 
    "massage_hours_close", "massage_hours_open", "massage_hours_type", "massage_additional_hours", "massage_menu_fees", 
    "massage_note", "massage_status", "massage_types", "membership_card", "motorcycle_parking", 
    "my_impression", "name", "nearest_station", "note", "notice_info", "onsen_tamago_status", 
    "open_time", "other_facility_note", "other_fees", "outdoor_facility_status", "outdoor_female", 
    "outdoor_indoor_note_female", "outdoor_indoor_note_male", "outdoor_location_female", 
    "outdoor_location_male", "outdoor_male", "parking_accessible", "parking_capacity", 
    "parking_conditions", "parking_fee_amount", "parking_fee_type", "parking_note", 
    "parking_status", "parking_temporary", "parking_types", "payment", "phone", "point_card", "spring_type", "source_type", 
    "pool_facility_status", "powder_room_female", "powder_room_male", "pre_rinse_water_female", 
    "pre_rinse_water_male", "prefecture", "price_note", "private_bath_capacity_female", 
    "private_bath_capacity_male", "private_bath_capacity_status_female", 
    "private_bath_capacity_status_male", "private_bath_duration_female", 
    "private_bath_duration_male", "private_bath_note_female", "private_bath_note_male", 
    "purchase_method", "recline_chair_count_female", "recline_chair_count_male", 
    "recline_chair_female", "recline_chair_male", "recycle_box_status", "rental_items_female", 
    "rental_items_male", "rental_space_status", "rest_space_condition", "rest_space_fee_amount", 
    "rest_space_fee_type", "rest_space_hours_close", "rest_space_hours_open", 
    "rest_space_hours_type", "rest_space_note", "rest_space_per_person_minutes", 
    "rest_space_per_person_type", "rest_space_status", "rest_space_type", "restaurant_close_time", 
    "restaurant_feature", "restaurant_hours_type", "restaurant_additional_hours", "restaurant_last_order", "restaurant_note", 
    "restaurant_open_time", "restaurant_other_info", "restaurant_payment", "restaurant_status", 
    "restaurant_types", "roof_rain_protection_female", "roof_rain_protection_male", 
    "sauna_aroma_loyly_female", "sauna_aroma_loyly_male", "sauna_aroma_type_female", 
    "sauna_aroma_type_male", "sauna_aufguss_female", "sauna_aufguss_male", 
    "sauna_capacity_number_female", "sauna_capacity_number_male", "sauna_capacity_range_female", 
    "sauna_capacity_range_male", "sauna_clock_female", "sauna_clock_male", 
    "sauna_door_type_female", "sauna_door_type_male", "sauna_emergency_button_female", 
    "sauna_emergency_button_male", "sauna_exit_direction_female", "sauna_exit_direction_male", 
    "sauna_facility_female", "sauna_facility_location_female", "sauna_facility_location_male", 
    "sauna_facility_male", "sauna_facility_suspended_female", "sauna_facility_suspended_male", 
    "sauna_goods_rental_female", "sauna_goods_rental_male", "sauna_goods_sale_female", 
    "sauna_goods_sale_male", "sauna_hourglass_female", "sauna_hourglass_male", 
    "sauna_hours_holiday_close_female", "sauna_hours_holiday_close_male", 
    "sauna_hours_holiday_open_female", "sauna_hours_holiday_open_male", 
    "sauna_hours_saturday_close_female", "sauna_hours_saturday_close_male", 
    "sauna_hours_saturday_open_female", "sauna_hours_saturday_open_male", 
    "sauna_hours_sunday_close_female", "sauna_hours_sunday_close_male", 
    "sauna_hours_sunday_open_female", "sauna_hours_sunday_open_male", "sauna_hours_type_female", 
    "sauna_hours_type_male", "sauna_hours_weekday_close_female", "sauna_hours_weekday_close_male", 
    "sauna_hours_weekday_open_female", "sauna_hours_weekday_open_male", 
    "sauna_humidity_max_female", "sauna_humidity_max_male", "sauna_humidity_min_female", 
    "sauna_humidity_min_male", "sauna_light_brightness_female", "sauna_light_brightness_male", 
    "sauna_loyly_female", "sauna_loyly_frequency_female", "sauna_loyly_frequency_male", 
    "sauna_loyly_interval_minutes_female", "sauna_loyly_interval_minutes_male", 
    "sauna_loyly_interval_note_female", "sauna_loyly_interval_note_male", "sauna_loyly_male", 
    "sauna_loyly_note_female", "sauna_loyly_note_male", "sauna_loyly_reservation_female", 
    "sauna_loyly_reservation_male", "sauna_loyly_type_female", "sauna_loyly_type_male", 
    "sauna_mat_placement_female", "sauna_mat_placement_male", "sauna_mat_rental_female", 
    "sauna_mat_rental_male", "sauna_mat_type_female", "sauna_mat_type_male", 
    "sauna_room_note_female", "sauna_room_note_male", "sauna_stones_female", "sauna_stones_male", 
    "sauna_stove_brand_female", "sauna_stove_brand_male", "sauna_stove_count_female", 
    "sauna_stove_count_male", "sauna_stove_count_status_female", "sauna_stove_count_status_male", 
    "sauna_stove_type_female", "sauna_stove_type_male", "sauna_temp_max_female", 
    "sauna_temp_max_male", "sauna_temp_min_female", "sauna_temp_min_male", 
    "sauna_thermometer_female", "sauna_thermometer_male", "sauna_tv_female", "sauna_tv_male", 
    "sauna_tv_remote_female", "sauna_tv_remote_male", "sauna_twelve_min_timer_female", 
    "sauna_twelve_min_timer_male", "sauna_types_female", "sauna_types_male", "scale_female", 
    "scale_male", "scenery_female", "scenery_male", "shampoo_conditioner_female", 
    "shampoo_conditioner_male", "shoebox_count_female", "shoebox_count_male", "shoebox_fee_female", 
    "shoebox_fee_male", "shoebox_key_type_female", "shoebox_key_type_male", "shoebox_note_female", 
    "shoebox_note_male", "shoebox_type_female", "shoebox_type_male", "shop_hours_close", "shop_additional_hours", "convenience_store_status", "convenience_store_hours_type", "convenience_store_hours", 
    "shop_hours_open", "shop_hours_type", "shop_items", "shop_note", "shop_payment", "shop_status", 
    "shower_booth_female", "shower_booth_male", "shower_chair_female", "shower_chair_male", 
    "shower_count_female", "shower_count_male", "shower_faucet_female", "shower_faucet_male", 
    "shower_head_info_female", "shower_head_info_male", "shower_note_female", "shower_note_male", 
    "shower_type_female", "shower_type_male", "soap_female", "soap_male", "source_free_flow", 
    "source_temperature", "spring_analysis", "spring_analysis_date", "spring_circulation", 
    "spring_color", "spring_dilution", "spring_disinfection", "spring_heating", 
    "spring_info_check_date", "spring_info_source", "spring_open_year", "spring_open_year_note", 
    "spring_ph", "spring_smell", "spring_source_name", "spring_takeaway_status", 
    "spring_temperature", "spring_texture", "spring_types", "spring_usage_note", 
    "sun_shade_female", "sun_shade_male", "tissue_female", "tissue_male", "toilet_accessible", 
    "toilet_baby_chair_in_toilet", "toilet_barrier_free_note", "toilet_diaper_table", 
    "toilet_elevator", "toilet_location_lobby", "toilet_location_other", 
    "toilet_mens_changing_room", "toilet_ostomate", "toilet_slope", "toilet_types", 
    "toilet_wheelchair", "toilet_womens_changing_room", "toiletry_shelf_female", 
    "toiletry_shelf_male", "tori_toi_chair_count_female", "tori_toi_chair_count_male", 
    "tori_toi_chair_female", "tori_toi_chair_male", "tori_toi_other_note_female", 
    "tori_toi_other_note_male", "trash_bin_female", "trash_bin_male", "twitter", "updated_at", 
    "usage", "user_info_source", "vanity_female", "vanity_male", "vending_machine_location", 
    "vending_machine_note", "vending_machine_status", "vending_machine_types", 
    "wash_area_divider_female", "wash_area_divider_male", "water_cooler_female", 
    "water_cooler_male", "website", "wifi_facility", "wifi_fee_minutes", "wifi_fee_price", 
    "wristband_payment"
  ]);

  // 配列（複数選択）として保存すべき列。過去バージョンのローカルデータ等で
  // 単純な文字列のまま入っている場合、そのままでは型エラーになるため
  // 送信前に配列へ変換する。
  const ARRAY_COLUMNS = new Set([
    "purchase_method",
    "overnight_days", "morning_bath_days", "other_hours_days",
    "bath_function_female", "bath_function_male", "bath_location_female", "bath_location_male", 
    "bath_shape_female", "bath_shape_male", "child_info_source", "closed_days", 
    "cold_bath_cooling_female", "cold_bath_cooling_male", "cold_bath_flow_female", 
    "cold_bath_flow_male", "cold_bath_location_female", "cold_bath_location_male", 
    "cold_bath_shape_female", "cold_bath_shape_male", "cold_bath_source_female", 
    "cold_bath_source_male", "coworking_features", "indications", "indoor_location_female", 
    "indoor_location_male", "laying_space_material_female", "laying_space_material_male", 
    "locker_key_type_female", "locker_key_type_male", "locker_size_female", "locker_size_male", 
    "locker_wristband_type_female", "locker_wristband_type_male", "locker_wristband_use_female", 
    "locker_wristband_use_male", "massage_types", "outdoor_location_female", 
    "outdoor_location_male", "parking_accessible", "parking_conditions", "parking_types", 
    "payment", "rest_space_type", "restaurant_other_info", "restaurant_payment", 
    "restaurant_types", "sauna_loyly_type_female", "sauna_loyly_type_male", 
    "sauna_mat_placement_female", "sauna_mat_placement_male", "sauna_mat_type_female", 
    "sauna_mat_type_male", "sauna_types_female", "sauna_types_male", "scenery_female", 
    "scenery_male", "shoebox_key_type_female", "shoebox_key_type_male", "shoebox_type_female", 
    "shoebox_type_male", "shop_items", "shop_payment", "shower_type_female", "shower_type_male", 
    "spring_color", "spring_info_source", "spring_smell", "spring_texture", "spring_types", 
    "toilet_types", "usage", "user_info_source", "vending_machine_location", 
    "vending_machine_types"
  ]);

  function filterKnownColumns(payload) {
    const filtered = {};
    Object.keys(payload).forEach((key) => {
      if (!KNOWN_COLUMNS.has(key)) return;

      let value = payload[key];

      if (ARRAY_COLUMNS.has(key) && value != null && !Array.isArray(value)) {
        // 昔の自由記述形式（文字列）を、配列形式に変換して保存する
        value = String(value).trim() ? [String(value).trim()] : [];
      }

      filtered[key] = value;
    });
    return filtered;
  }

  async function insertSupabaseData(item) {
    if (!supabaseClient) return null;

    // Supabase側に存在しない id / updated_at の扱いを避けるため、
    // まずフォーム由来の項目だけを送ります。
    const payload = filterKnownColumns(item);
    delete payload.id;

    const { data, error } = await supabaseClient
      .from(TABLE_NAME)
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error("Supabase保存エラー:", error);
      throw error;
    }

    return data;
  }

  async function updateSupabaseData(id, item) {
    if (!supabaseClient) return null;

    const payload = filterKnownColumns(item);
    delete payload.id;

    const { data, error } = await supabaseClient
      .from(TABLE_NAME)
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("Supabase更新エラー:", error);
      throw error;
    }

    return data;
  }

  async function deleteSupabaseData(id) {
    if (!supabaseClient) return;

    const { error } = await supabaseClient
      .from(TABLE_NAME)
      .delete()
      .eq("id", id);

    if (error) {
      console.error("Supabase削除エラー:", error);
      throw error;
    }
  }

  function updateLocalData(id, item) {
    const list = getLocalData();
    const index = list.findIndex((entry) => String(entry.id) === String(id));

    if (index === -1) return null;

    const updated = { ...item, id };
    list[index] = updated;
    saveLocalData(list);

    return updated;
  }

  function deleteLocalData(id) {
    const list = getLocalData();
    const filtered = list.filter((entry) => String(entry.id) !== String(id));
    saveLocalData(filtered);
  }

  // ---------------------------------------------------------
  // 一覧表示
  // ---------------------------------------------------------

  // ---------------------------------------------------------
  // 絞り込み検索
  // ---------------------------------------------------------

  window.__activeFacetFilters = null;
  let filterPriceSliderTouched = false;

  function getMinBathFeeAmount(item) {
    if (!Array.isArray(item.bath_fees) || !item.bath_fees.length) return null;
    const adult = item.bath_fees.find((f) => f.category && f.category.includes("大人"));
    if (adult && adult.amount != null) return adult.amount;
    const amounts = item.bath_fees.map((f) => f.amount).filter((a) => a != null);
    return amounts.length ? Math.min(...amounts) : null;
  }

  function getAdultBathFeeAmount(item) {
    if (!Array.isArray(item.bath_fees) || !item.bath_fees.length) return null;
    const adult = item.bath_fees.find((f) => f.category && f.category.includes("大人"));
    return adult && adult.amount != null ? adult.amount : null;
  }

  const FACILITY_CATEGORY_MATCHERS = {
    "日帰り入浴可": (item) => Array.isArray(item.usage) && item.usage.includes("日帰り入浴可"),
    "露天風呂": (item) =>
      [item.bath_shape_male, item.bath_shape_female].some(
        (arr) => Array.isArray(arr) && arr.includes("露天風呂・半露天風呂")
      ),
    "朝風呂": (item) => Boolean(item.morning_bath_open_time || item.morning_bath_close_time),
    "家族風呂": (item) =>
      [item.bath_shape_male, item.bath_shape_female].some(
        (arr) => Array.isArray(arr) && arr.includes("家族風呂")
      ),
    "サウナ": (item) =>
      item.sauna_facility_male === "あり" || item.sauna_facility_female === "あり",
    "ロウリュ": (item) =>
      item.sauna_loyly_male === "あり" || item.sauna_loyly_female === "あり",
    "水風呂": (item) =>
      item.cold_bath_availability_male === "あり" ||
      item.cold_bath_availability_female === "あり",
    "外気浴": (item) =>
      item.outdoor_male === "あり" || item.outdoor_female === "あり",
    "お食事処": (item) => item.restaurant_status === "あり",
    "リラクゼーション": (item) => item.massage_status === "あり",
    "休憩スペース": (item) => item.rest_space_status === "あり",
    "売店コーナー": (item) => item.shop_status === "あり",
    "コインランドリー": (item) => item.coin_laundry_status === "あり",
    "レンタルスペース": (item) => item.rental_space_status === "あり"
  };

  function passesKidsAgeFilter(item, age) {
    if (age == null || age === "") return true;
    if (item.child_mixed_bathing !== "あり") return false;
    if (item.child_age_limit === "なし") return true;
    const limits = [item.child_boy_age_limit, item.child_girl_age_limit].filter(
      (v) => v != null
    );
    if (!limits.length) return true;
    return limits.some((limit) => Number(limit) >= Number(age));
  }

  function itemMatchesFacetFilters(item) {
    const filters = window.__activeFacetFilters;
    if (!filters) return true;

    // 検索エリア（都道府県・市区町村）
    if (filters.prefectures && filters.prefectures.length) {
      if (!filters.prefectures.includes(item.prefecture)) return false;

      const cities = filters.cities && filters.cities[item.prefecture];
      if (cities && cities.length && !cities.includes(item.area)) return false;
    }

    // 施設業態
    if (filters.businessTypes && filters.businessTypes.length) {
      if (!filters.businessTypes.includes(item.business_type)) return false;
    }

    // 施設分類（選んだものすべてに合致する施設だけ表示）
    if (filters.categories && filters.categories.length) {
      const allMatch = filters.categories.every((cat) => {
        const matcher = FACILITY_CATEGORY_MATCHERS[cat];
        return matcher ? matcher(item) : true;
      });
      if (!allMatch) return false;
    }

    // 料金
    if (filters.priceMode === "max") {
      const fee = getMinBathFeeAmount(item);
      if (fee == null || fee > filters.priceMax) return false;
    } else if (filters.priceMode === "min2000") {
      const fee = getMinBathFeeAmount(item);
      if (fee == null || fee < 2000) return false;
    }

    // 家族連れ検索
    if (filters.kidsOk) {
      if (Array.isArray(item.usage) && item.usage.includes("会員制")) return false;
    }
    if (filters.kidsMixedBathing && item.child_mixed_bathing !== "あり") return false;
    if (!passesKidsAgeFilter(item, filters.kidsAge)) return false;

    // 駐車場検索
    if (filters.parking && filters.parking.length) {
      const parkingMatchers = {
        "駐車場あり": (i) => i.parking_status === "あり",
        "無料駐車場": (i) => i.parking_fee_type === "無料",
        "大型車駐車場あり": (i) =>
          Array.isArray(i.parking_accessible) && i.parking_accessible.includes("大型車駐車スペース")
      };
      const allMatch = filters.parking.every((key) =>
        parkingMatchers[key] ? parkingMatchers[key](item) : true
      );
      if (!allMatch) return false;
    }

    return true;
  }

  function buildCityFilterGroups() {
    // 古いフラットなコンテナは常に空にしておく（レイアウト変更前の名残）
    const legacyContainer = $("filterCityContainer");
    if (legacyContainer) legacyContainer.innerHTML = "";

    // 各地方区分のスロットをいったんクリア
    document.querySelectorAll(".filter-city-slot").forEach((slot) => {
      slot.innerHTML = "";
    });

    const checkedPrefBoxes = Array.from(
      document.querySelectorAll(".filter-prefecture:checked")
    );

    checkedPrefBoxes.forEach((prefBox) => {
      const pref = prefBox.value;
      const areas = Array.from(
        new Set(
          (window.__onsenData || [])
            .filter((item) => item.prefecture === pref && item.area)
            .map((item) => item.area)
        )
      );

      const rawCityOrder = window.MUNICIPALITIES_BY_PREFECTURE?.[pref] || [];
      const cityOrder = rawCityOrder.map((name) => name.replace(/^.+?郡/, ""));
      areas.sort((a, b) => {
        const ai = cityOrder.indexOf(a);
        const bi = cityOrder.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b, "ja");
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });

      if (!areas.length) return;

      const regionFieldset = prefBox.closest(".filter-region");
      const slot = regionFieldset ? regionFieldset.querySelector(".filter-city-slot") : null;
      if (!slot) return;

      const group = document.createElement("div");
      group.className = "filter-city-group";
      group.dataset.prefecture = pref;

      const title = document.createElement("p");
      title.className = "field-title";
      title.textContent = `${pref}の市区町村（すべて・または選択）`;
      group.appendChild(title);

      const checksWrap = document.createElement("div");
      checksWrap.className = "checks";
      areas.forEach((area) => {
        const label = document.createElement("label");
        label.innerHTML = `<input type="checkbox" class="filter-city" data-prefecture="${escapeHtml(pref)}" value="${escapeHtml(area)}">${escapeHtml(area)}`;
        checksWrap.appendChild(label);
      });
      group.appendChild(checksWrap);
      slot.appendChild(group);
    });
  }

  function collectFacetFilters() {
    const prefectures = Array.from(
      document.querySelectorAll(".filter-prefecture:checked")
    ).map((el) => el.value);

    const cities = {};
    document.querySelectorAll(".filter-city:checked").forEach((el) => {
      const pref = el.dataset.prefecture;
      if (!cities[pref]) cities[pref] = [];
      cities[pref].push(el.value);
    });

    const businessTypes = Array.from(
      document.querySelectorAll(".filter-business-type:checked")
    ).map((el) => el.value);

    const categories = Array.from(
      document.querySelectorAll(".filter-category:checked")
    ).map((el) => el.value);

    const priceRadio = radioValue("filterPrice");
    let priceMode = "all";
    let priceMax = null;
    if (filterPriceSliderTouched) {
      priceMode = "max";
      priceMax = Number(value("filterPriceSlider"));
    } else if (priceRadio === "2000円以上") {
      priceMode = "min2000";
    } else if (priceRadio && priceRadio !== "すべて") {
      priceMode = "max";
      priceMax = Number(priceRadio.replace(/[^0-9]/g, ""));
    } else if (priceRadio === "すべて") {
      priceMode = "all";
    }

    const parking = Array.from(
      document.querySelectorAll(".filter-parking:checked")
    ).map((el) => el.value);

    const kidsAgeValue = value("filterKidsAge");

    const filters = {
      prefectures,
      cities,
      businessTypes,
      categories,
      priceMode,
      priceMax,
      kidsOk: checkedBool("filterKidsOk"),
      kidsMixedBathing: checkedBool("filterKidsMixedBathing"),
      kidsAge: kidsAgeValue === "" ? null : Number(kidsAgeValue),
      parking
    };

    const isEmpty =
      !filters.prefectures.length &&
      !filters.businessTypes.length &&
      !filters.categories.length &&
      filters.priceMode === "all" &&
      !filters.kidsOk &&
      !filters.kidsMixedBathing &&
      filters.kidsAge == null &&
      !filters.parking.length;

    return isEmpty ? null : filters;
  }

  function resetFilterForm() {
    filterPriceSliderTouched = false;
    document.querySelectorAll(".filter-prefecture").forEach((el) => (el.checked = false));
    document.querySelectorAll(".filter-city").forEach((el) => (el.checked = false));
    $("filterCityContainer").innerHTML = "";
    document.querySelectorAll(".filter-city-slot").forEach((slot) => (slot.innerHTML = ""));
    document.querySelectorAll(".filter-business-type").forEach((el) => (el.checked = false));
    document.querySelectorAll(".filter-category").forEach((el) => (el.checked = false));
    if ($("filterCategoryAll")) $("filterCategoryAll").checked = false;
    document.querySelectorAll('input[name="filterPrice"]').forEach((el, i) => {
      el.checked = i === 0;
    });
    if ($("filterPriceSlider")) $("filterPriceSlider").value = 2000;
    if ($("filterPriceSliderValue")) $("filterPriceSliderValue").textContent = "2,000";
    if ($("filterKidsOk")) $("filterKidsOk").checked = false;
    if ($("filterKidsMixedBathing")) $("filterKidsMixedBathing").checked = false;
    if ($("filterKidsAge")) $("filterKidsAge").value = "";
    document.querySelectorAll(".filter-parking").forEach((el) => (el.checked = false));
    if ($("filterParkingAll")) $("filterParkingAll").checked = false;
  }

  function getFilteredSortedList(list) {
    const search = value("search").toLowerCase();

    const filtered = list.filter((item) => {
      if (!itemMatchesFacetFilters(item)) return false;
      if (!search) return true;

      const text = [
        item.name,
        item.prefecture,
        item.area,
        item.address,
        item.business_type,
        Array.isArray(item.spring_types) ? item.spring_types.join(" ") : ""
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return text.includes(search);
    });

    const userLoc = window.__userLocation;
    const sortMode = $("sortModeSelect")?.value || "distance";

    if (sortMode === "distance" && userLoc) {
      filtered.sort((a, b) => {
        const aHas = a.lat != null && a.lng != null;
        const bHas = b.lat != null && b.lng != null;
        if (aHas && bHas) {
          return (
            distanceKm(userLoc.lat, userLoc.lng, Number(a.lat), Number(a.lng)) -
            distanceKm(userLoc.lat, userLoc.lng, Number(b.lat), Number(b.lng))
          );
        }
        if (aHas) return -1;
        if (bHas) return 1;
        return 0;
      });
    } else if (sortMode === "distanceDesc" && userLoc) {
      filtered.sort((a, b) => {
        const aHas = a.lat != null && a.lng != null;
        const bHas = b.lat != null && b.lng != null;
        if (aHas && bHas) {
          return (
            distanceKm(userLoc.lat, userLoc.lng, Number(b.lat), Number(b.lng)) -
            distanceKm(userLoc.lat, userLoc.lng, Number(a.lat), Number(a.lng))
          );
        }
        if (aHas) return -1;
        if (bHas) return 1;
        return 0;
      });
    } else if (sortMode === "priceAsc") {
      filtered.sort((a, b) => {
        const aPrice = getAdultBathFeeAmount(a);
        const bPrice = getAdultBathFeeAmount(b);
        if (aPrice == null && bPrice == null) return 0;
        if (aPrice == null) return 1;
        if (bPrice == null) return -1;
        return aPrice - bPrice;
      });
    } else if (sortMode === "ratingDesc") {
      filtered.sort((a, b) => {
        const aRating = window.__ratingSummary?.[a.id]?.average ?? -1;
        const bRating = window.__ratingSummary?.[b.id]?.average ?? -1;
        return bRating - aRating;
      });
    } else if (sortMode === "nameAsc") {
      filtered.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
    } else if (sortMode === "newest") {
      filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    } else if (sortMode === "updated") {
      filtered.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
    }

    return filtered;
  }

  const CATEGORY_TAG_EMOJIS = {
    "日帰り入浴可": "♨️",
    "露天風呂": "♨️",
    "朝風呂": "☀️",
    "家族風呂": "👨‍👩‍👦",
    "サウナ": "🧖‍♀️",
    "ロウリュ": "🔥",
    "水風呂": "💧",
    "外気浴": "🌿",
    "お食事処": "🍴",
    "売店コーナー": "🛍",
    "リラクゼーション": "💆‍♀️",
    "休憩スペース": "🛋",
    "コインランドリー": "🧺",
    "レンタルスペース": "👩🏻‍💻"
  };

  function buildOutlineStyle(outlineColors) {
    return outlineColors.length
      ? `box-shadow:0 5px 18px #3a271610${outlineColors
          .map((color, i) => `,0 0 0 ${3 * (i + 1)}px ${color}`)
          .join("")}`
      : "box-shadow:0 5px 18px #3a271610";
  }

  function getUsageBadgesAndOutline(item) {
    const outlineColors = [];
    const badges = [];

    if (item.is_closed) {
      outlineColors.push("#1a1a1a");
      badges.push({ cls: "card-corner-badge-closed", label: "🚫 閉鎖済み" });
    } else if (item.is_temp_closed) {
      outlineColors.push("#d64545");
      badges.push({ cls: "card-corner-badge-temp-closed", label: "⚠️ 臨時休業中" });
    }

    if (Array.isArray(item.usage)) {
      if (item.usage.includes("宿泊者のみ")) {
        outlineColors.push("#7c5cbf");
        badges.push({ cls: "card-corner-badge-guest", label: "🛌 宿泊者限定" });
      }
      if (item.usage.includes("男性専用")) {
        outlineColors.push("#3b6fd6");
        badges.push({ cls: "card-corner-badge-male", label: "🚹 男性専用" });
      }
      if (item.usage.includes("女性専用")) {
        outlineColors.push("#e0629c");
        badges.push({ cls: "card-corner-badge-female", label: "🚺 女性専用" });
      }
      if (item.usage.includes("会員制")) {
        outlineColors.push("#e8c300");
        badges.push({ cls: "card-corner-badge-member", label: "👤 会員制" });
      }
    }

    const outlineStyle = buildOutlineStyle(outlineColors);

    const badgesHtml = badges.length
      ? `<div class="card-corner-badges">${badges
          .map((b) => `<span class="card-corner-badge ${b.cls}">${b.label}</span>`)
          .join("")}</div>`
      : "";

    return { outlineStyle, outlineColors, badgesHtml };
  }

  const LIST_PAGE_SIZE = 50;
  let listDisplayLimit = LIST_PAGE_SIZE;
  let lastListFilterSignature = null;
  let lastRenderCardsList = null;

  function renderCards(list) {
    const cards = $("cards");
    const count = $("count");

    if (!cards) return;

    lastRenderCardsList = list;

    const search = value("search").toLowerCase();
    const filtered = getFilteredSortedList(list);
    const userLoc = window.__userLocation;

    // 検索・絞り込み・並び順が変わったら表示件数を50件にリセットする
    const filterSignature = JSON.stringify({
      search,
      filters: window.__activeFacetFilters || null,
      sort: value("sortModeSelect")
    });
    if (filterSignature !== lastListFilterSignature) {
      listDisplayLimit = LIST_PAGE_SIZE;
      lastListFilterSignature = filterSignature;
    }

    if (count) {
      count.textContent = `${filtered.length}件`;
    }

    const filterActive = window.__activeFacetFilters != null;
    const statusEl = $("status");
    if (statusEl) {
      statusEl.innerHTML = `現在 ${filtered.length}件の施設を表示中です （🔎 絞り込み検索　${filterActive ? "起動中" : "解除中"}）`;
      statusEl.className = "status ok";
    }

    if (!filtered.length) {
      cards.innerHTML = `
        <div class="status">
          ${
            search
              ? "検索条件に一致する温泉はありません。"
              : "まだ温泉が登録されていません。"
          }
        </div>
      `;
      const showMoreButton = $("showMoreButton");
      showMoreButton?.classList.add("hidden");
      return;
    }

    // マップで確認中の施設があれば、一覧の先頭に移動する
    let pinnedBannerHtml = "";
    if (highlightedFacilityId) {
      const pinnedIndex = filtered.findIndex((it) => String(it.id) === String(highlightedFacilityId));
      if (pinnedIndex > -1) {
        const [pinnedItem] = filtered.splice(pinnedIndex, 1);
        filtered.unshift(pinnedItem);
        pinnedBannerHtml = `<div class="pinned-banner"><span>📍 現在マップ上で確認している施設</span><button type="button" id="clearHighlightButton" class="pinned-banner-close" aria-label="解除する">✕</button></div>`;
      }
    }

    const visibleFiltered = filtered.slice(0, listDisplayLimit);

    cards.innerHTML =
      pinnedBannerHtml +
      visibleFiltered
        .map((item) => {
        const address = item.address || "";

        const distanceText =
          userLoc && item.lat != null && item.lng != null
            ? `${distanceKm(userLoc.lat, userLoc.lng, Number(item.lat), Number(item.lng)).toFixed(1)}km`
            : "";

        const status = getOpenStatus(item);

        const hoursText = item.is_24_hours
          ? "24時間営業"
          : item.open_time || item.close_time
          ? `${ft(item.open_time) || "?"}〜${ft(item.close_time) || "?"}`
          : "";

        const closedDaysText = getClosedDayTags(item).join("・");

        const morningBathHoursText =
          item.morning_bath_open_time || item.morning_bath_close_time
            ? `${ft(item.morning_bath_open_time) || "?"}〜${ft(item.morning_bath_close_time) || "?"}`
            : "";

        const categoryTags = Object.keys(CATEGORY_TAG_EMOJIS).filter((cat) => {
          const matcher = FACILITY_CATEGORY_MATCHERS[cat];
          return matcher ? matcher(item) : false;
        });

        const { outlineColors, badgesHtml } = getUsageBadgesAndOutline(item);
        const isPinnedCard = String(item.id) === String(highlightedFacilityId);
        const outlineStyle = buildOutlineStyle(isPinnedCard ? [...outlineColors, "#875020"] : outlineColors);

        return `
          <article class="card${isPinnedCard ? " pinned-highlight" : ""}" data-id="${escapeHtml(item.id ?? "")}" tabindex="0" role="button" aria-label="${escapeHtml(item.name || "名称未設定")}の詳細を見る" style="${outlineStyle}">
            ${badgesHtml}
            <div class="card-head">
              <h3>${escapeHtml(item.name || "名称未設定")}</h3>
            </div>

            ${address ? `<p class="card-place">📍 ${escapeHtml(address)}</p>` : ""}

            ${distanceText ? `<p class="card-distance">現在地から　${escapeHtml(distanceText)}</p>` : ""}
            ${(() => {
              const summary = window.__ratingSummary?.[item.id];
              if (!summary || !summary.count) return "";
              return `<p class="card-rating"><span class="card-rating-score">⭐️ ${summary.average.toFixed(1)}</span>　${summary.count}件の評価</p>`;
            })()}

            <div class="card-badges">
              ${item.business_type ? renderBusinessTypeBadge(item.business_type) : ""}
              ${status ? `<span class="status-badge ${status.className}">${escapeHtml(status.label)}</span>` : ""}
            </div>

            ${hoursText ? `<p>🕒 営業時間：${escapeHtml(hoursText)}</p>` : ""}
            ${morningBathHoursText ? `<p>☀️ 朝風呂：${escapeHtml(morningBathHoursText)}</p>` : ""}
            ${closedDaysText ? `<p>🗓 定休日：${escapeHtml(closedDaysText)}</p>` : ""}
            ${item.is_temp_closed && item.temp_closed_detail ? `<p class="card-temp-closed-detail">${escapeHtml(item.temp_closed_detail)}</p>` : ""}
            ${(() => {
              if (!Array.isArray(item.bath_fees) || !item.bath_fees.length) return "";
              const parts = item.bath_fees
                .filter((f) => f.category && f.amount != null && f.amount !== "")
                .map((f) => `${f.category} ${f.amount}円`);
              return parts.length
                ? `<p class="card-price">💰 料金：${escapeHtml(parts.join("　"))}</p>`
                : "";
            })()}

            ${
              categoryTags.length
                ? `<div class="card-category-tags">${categoryTags
                    .map((cat) => `<span class="badge">${CATEGORY_TAG_EMOJIS[cat]} ${escapeHtml(cat)}</span>`)
                    .join("")}</div>`
                : ""
            }

            ${(() => {
              const cardLinks = [
                item.website ? { label: "公式サイト", url: item.website } : null,
                item.instagram ? { label: "Instagram", url: item.instagram } : null,
                item.twitter ? { label: "X（旧Twitter）", url: item.twitter } : null,
                item.facebook ? { label: "Facebook", url: item.facebook } : null
              ].filter(Boolean);

              return cardLinks.length
                ? `<p class="card-links">${cardLinks
                    .map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${l.label}</a>`)
                    .join("　")}</p>`
                : "";
            })()}

            <div class="card-action-row">
              ${(() => {
                const destination =
                  item.lat != null && item.lng != null
                    ? `${item.lat},${item.lng}`
                    : item.address || item.name;
                if (!destination) return `<span class="card-action-half"></span>`;
                const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
                return `<a href="${escapeHtml(directionsUrl)}" target="_blank" rel="noopener" class="card-action-half card-action-route">🚗 経路を確認する</a>`;
              })()}
              ${
                item.lat != null && item.lng != null
                  ? `<button type="button" class="show-on-map card-action-half" data-id="${escapeHtml(item.id ?? "")}">🗺 地図で確認する</button>`
                  : ""
              }
            </div>
            <div class="card-action-row">
              ${(() => {
                const status = myFacilityStatusMap[item.id] || {};
                return `
                  <button type="button" class="toggle-interested card-action-half${status.interested ? " active" : ""}" data-id="${escapeHtml(item.id ?? "")}">❤️ ここ気になる</button>
                  <button type="button" class="toggle-visited card-action-half${status.visited ? " active" : ""}" data-id="${escapeHtml(item.id ?? "")}">✅ 行ったことある</button>
                `;
              })()}
            </div>
          </article>
        `;
      })
      .join("");

    const showMoreButton = $("showMoreButton");
    if (showMoreButton) {
      showMoreButton.classList.toggle("hidden", filtered.length <= listDisplayLimit);
    }
  }

  // ---------------------------------------------------------
  // 温泉詳細画面
  // ---------------------------------------------------------

  function findItemById(id) {
    return (window.__onsenData || []).find(
      (item) => String(item.id) === String(id)
    );
  }

  async function fetchItemById(id) {
    const cached = findItemById(id);
    if (cached) return cached;

    if (supabaseClient) {
      const { data, error } = await supabaseClient
        .from(TABLE_NAME)
        .select("*")
        .eq("id", id)
        .single();

      if (error) {
        console.error("Supabase詳細取得エラー:", error);
        return null;
      }
      return data;
    }

    return null;
  }

  function detailField(label, value) {
    if (value === null || value === undefined || value === "") return "";
    return `
      <div class="detail-item">
        <dt>${escapeHtml(label)}</dt>
        <dd>${escapeHtml(value)}</dd>
      </div>
    `;
  }

  function detailPhoneField(label, phone) {
    if (!phone) return "";

    const telHref = phone.replace(/[^0-9+]/g, "");
    return `
      <div class="detail-item">
        <dt>${escapeHtml(label)}</dt>
        <dd><a class="detail-phone" href="tel:${escapeHtml(telHref)}">${escapeHtml(phone)}</a></dd>
      </div>
    `;
  }

  function detailTags(list) {
    if (!Array.isArray(list) || !list.length) return "";
    return `
      <div class="detail-tags">
        ${list.map((v) => `<span class="badge">${escapeHtml(v)}</span>`).join("")}
      </div>
    `;
  }

  function detailSubhead(title) {
    return `<h4 class="detail-subhead">${escapeHtml(title)}</h4>`;
  }

  function renderFeeList(fees) {
    if (!Array.isArray(fees) || !fees.length) {
      return `<p class="detail-note-tight">情報がありません。</p>`;
    }

    return `
      <ul class="rental-list">
        ${fees
          .map((f) => `<li>${escapeHtml(f.category)}：${f.amount != null ? `${f.amount}円` : "料金不明"}</li>`)
          .join("")}
      </ul>
    `;
  }

  function renderTicketFeeList(fees) {
    if (!Array.isArray(fees) || !fees.length) {
      return `<p class="detail-note-tight">情報がありません。</p>`;
    }
    return `
      <ul class="rental-list">
        ${fees
          .map(
            (f) =>
              `<li>${escapeHtml(f.category)}：${f.sheets != null ? `${f.sheets}枚つづり` : ""}${f.price != null ? `　${f.price}円` : ""}</li>`
          )
          .join("")}
      </ul>
    `;
  }

  function renderBenefitList(items) {
    if (!Array.isArray(items) || !items.length) {
      return `<p class="detail-note-tight">情報がありません。</p>`;
    }
    return `
      <ul class="rental-list">
        ${items
          .map((it) => `<li>${escapeHtml(it.service || "対象サービス不明")}：${escapeHtml(it.content || "")}</li>`)
          .join("")}
      </ul>
    `;
  }

  const BUSINESS_TYPE_STYLES = {
    "日帰り温泉": { emoji: "♨️", bg: "#d64545", color: "#fff" },
    "銭湯・公衆浴場": { emoji: "♨️", bg: "#8b5e3c", color: "#fff" },
    "スーパー銭湯": { emoji: "♨️", bg: "#e8c300", color: "#4a3b00" },
    "温泉旅館": { emoji: "🛌", bg: "#7c5cbf", color: "#fff" },
    "ホテル": { emoji: "🏨", bg: "#7c5cbf", color: "#fff" },
    "サウナ施設": { emoji: "🧖‍♀️", bg: "#e0761f", color: "#fff" },
    "スパ施設": { emoji: "💆‍♀️", bg: "#6b8e23", color: "#fff" },
    "プール施設": { emoji: "🏊", bg: "#3b6fd6", color: "#fff" },
    "アウトドア施設": { emoji: "🏕", bg: "#3f9142", color: "#fff" },
    "スポーツジム": { emoji: "🏃‍♀️", bg: "#4fb3d9", color: "#fff" },
    "複合施設": { emoji: "🎡", bg: "#e0629c", color: "#fff" },
    "その他": { emoji: "🏢", bg: "#ffffff", color: "#4a3b00", border: "1px solid #e1dcd7" }
  };

  // 業態の表示名の上書き（保存される値はそのままで、表示テキストだけ変える）
  const BUSINESS_TYPE_DISPLAY_LABELS = {
    "その他": "その他の施設"
  };

  function businessTypeDisplayLabel(businessType) {
    return BUSINESS_TYPE_DISPLAY_LABELS[businessType] || businessType;
  }

  function renderBusinessTypeBadge(businessType) {
    if (!businessType) {
      return `<p class="detail-note-tight">情報がありません。</p>`;
    }

    const style = BUSINESS_TYPE_STYLES[businessType] || {
      emoji: "🏳️",
      bg: "#8a968f",
      color: "#fff"
    };

    return `
      <p class="detail-note-tight">
        <span class="type-badge" style="background:${style.bg};color:${style.color}${style.border ? `;border:${style.border}` : ""}">
          ${style.emoji} ${escapeHtml(businessTypeDisplayLabel(businessType))}
        </span>
      </p>
    `;
  }

  // ---------------------------------------------------------
  // 日本の祝日判定（内閣府の祝日ルールに基づく簡易計算）
  // ---------------------------------------------------------

  function nthMondayOfMonth(year, month, n) {
    let count = 0;
    for (let day = 1; day <= 31; day++) {
      const d = new Date(year, month - 1, day);
      if (d.getMonth() !== month - 1) break;
      if (d.getDay() === 1) {
        count += 1;
        if (count === n) return day;
      }
    }
    return null;
  }

  function vernalEquinoxDay(year) {
    return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  function autumnalEquinoxDay(year) {
    return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  function getJapaneseHolidaySet(year) {
    const set = new Set();
    const add = (m, d) => d && set.add(`${m}-${d}`);
    add(1, 1);
    add(1, nthMondayOfMonth(year, 1, 2));
    add(2, 11);
    add(2, 23);
    add(3, vernalEquinoxDay(year));
    add(4, 29);
    add(5, 3);
    add(5, 4);
    add(5, 5);
    add(7, nthMondayOfMonth(year, 7, 3));
    add(8, 11);
    add(9, nthMondayOfMonth(year, 9, 3));
    add(9, autumnalEquinoxDay(year));
    add(10, nthMondayOfMonth(year, 10, 2));
    add(11, 3);
    add(11, 23);
    return set;
  }

  function isJapaneseHoliday(date) {
    const holidays = getJapaneseHolidaySet(date.getFullYear());
    const key = `${date.getMonth() + 1}-${date.getDate()}`;
    if (holidays.has(key)) return true;

    // 振替休日：日曜が祝日だった場合、翌月曜も休日になる
    if (date.getDay() === 1) {
      const yesterday = new Date(date);
      yesterday.setDate(date.getDate() - 1);
      if (
        yesterday.getDay() === 0 &&
        getJapaneseHolidaySet(yesterday.getFullYear()).has(
          `${yesterday.getMonth() + 1}-${yesterday.getDate()}`
        )
      ) {
        return true;
      }
    }
    return false;
  }

  function getClosedDayTags(item) {
    const tags = [];
    if (Array.isArray(item.closed_days)) {
      item.closed_days.forEach((d) => {
        tags.push(["日", "月", "火", "水", "木", "金", "土"].includes(d) ? `${d}曜日` : d);
      });
    }
    if (Array.isArray(item.closed_nth_weeks) && item.closed_nth_weeks.length && item.closed_nth_weekday) {
      tags.push(`${item.closed_nth_weeks.join("・")}${item.closed_nth_weekday}曜日`);
    }
    if (item.closed_monthly_dates) {
      tags.push(`毎月${item.closed_monthly_dates}`);
    }
    if (item.closed_irregular) tags.push("不定休");
    if (item.closed_calendar_based) tags.push("営業カレンダーによる");
    if (item.is_temp_closed) tags.push("臨時休業中");
    if (item.is_closed) tags.push("閉鎖済み");
    return tags;
  }

  function getOpenStatus(item) {
    // 将来的なフラグ（閉鎖・臨時休業）に対応
    if (item.is_closed) {
      return { label: "閉鎖中", className: "status-closed-permanently" };
    }
    if (item.is_temp_closed) {
      return { label: "臨時休業中", className: "status-temp-closed" };
    }

    const weekdayChars = ["日", "月", "火", "水", "木", "金", "土"];
    const now = new Date();
    const todayChar = weekdayChars[now.getDay()];
    const todayIsHoliday = isJapaneseHoliday(now);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayChar = weekdayChars[yesterday.getDay()];
    const yesterdayWasHoliday = isJapaneseHoliday(yesterday);

    const todayNormallyClosed =
      Array.isArray(item.closed_days) && item.closed_days.includes(todayChar);
    const holidayRule = item.closed_holiday_rule;

    // 「祝日の場合は翌営業日が定休」：昨日が定休日と重なる祝日だった場合、今日を定休日にする
    if (
      holidayRule === "祝日の場合は翌営業日が定休" &&
      yesterdayWasHoliday &&
      Array.isArray(item.closed_days) &&
      item.closed_days.includes(yesterdayChar)
    ) {
      return { label: "定休日", className: "status-holiday" };
    }

    // 定休日の曜日が祝日と重なった場合の特別ルール（今日はいつも通り営業）
    const holidayOverridesClosure =
      todayIsHoliday &&
      todayNormallyClosed &&
      (holidayRule === "祝日は営業" || holidayRule === "祝日の場合は翌営業日が定休");

    // 定休日（曜日の複数選択）に今日が含まれていれば定休日と判定
    if (todayNormallyClosed && !holidayOverridesClosure) {
      return { label: "定休日", className: "status-holiday" };
    }
    if (todayIsHoliday && Array.isArray(item.closed_days) && item.closed_days.includes("祝日")) {
      return { label: "定休日", className: "status-holiday" };
    }

    if (item.is_24_hours) {
      return { label: "現在 営業中", className: "status-open" };
    }

    // 今日が祝日で「祝日」の営業時間が設定されていればそちらを優先し、
    // 次に「曜日によって異なる営業時間」、どちらもなければ通常の営業時間を使う
    const overrides = item.weekday_hours_overrides || {};
    const todayOverride = (todayIsHoliday && overrides["祝"]) || overrides[todayChar];
    const effectiveOpenTime = todayOverride?.open || item.open_time;
    const effectiveCloseTime = todayOverride?.close || item.close_time;
    const effectiveLastEntry = todayOverride?.lastEntry || item.last_entry;

    const toMinutes = (t) => {
      if (!t) return null;
      const [h, m] = t.split(":").map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      return h * 60 + m;
    };

    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // 対象曜日（未選択なら毎日）に今日が含まれているか判定（祝日指定にも対応）
    const daysMatchToday = (days) =>
      !Array.isArray(days) ||
      !days.length ||
      days.includes(todayChar) ||
      (todayIsHoliday && days.includes("祝"));

    // 通常営業時間・曜日別営業時間・宿泊者限定・朝風呂・その他の営業時間、
    // すべての時間帯を候補として、現在時刻がどこに当てはまるか調べる
    const additionalWindows = (parentDays, list) =>
      Array.isArray(list)
        ? list
            .filter((w) => daysMatchToday(Array.isArray(w.days) && w.days.length ? w.days : parentDays))
            .map((w) => ({ open: w.open, close: w.close, lastEntry: w.lastEntry }))
        : [];

    const candidateWindows = [
      { open: effectiveOpenTime, close: effectiveCloseTime, lastEntry: effectiveLastEntry },
      daysMatchToday(item.overnight_days)
        ? { open: item.overnight_open_time, close: item.overnight_close_time, lastEntry: item.overnight_last_entry }
        : null,
      ...additionalWindows(item.overnight_days, item.overnight_additional_hours),
      daysMatchToday(item.morning_bath_days)
        ? { open: item.morning_bath_open_time, close: item.morning_bath_close_time, lastEntry: item.morning_bath_last_entry }
        : null,
      ...additionalWindows(item.morning_bath_days, item.morning_bath_additional_hours),
      daysMatchToday(item.other_hours_days)
        ? { open: item.other_hours_open_time, close: item.other_hours_close_time, lastEntry: item.other_hours_last_entry }
        : null,
      ...additionalWindows(item.other_hours_days, item.other_hours_additional_hours)
    ].filter((w) => w && w.open && w.close);

    if (!candidateWindows.length) return null;

    // 1つの時間帯について「営業中か」「最終受付を過ぎているか」を判定
    function evaluateWindow(w) {
      const openMinutes = toMinutes(w.open);
      const closeMinutes = toMinutes(w.close);
      if (openMinutes == null || closeMinutes == null) return { isOpen: false, pastLastEntry: false };

      const crossesMidnight = closeMinutes <= openMinutes;
      const isOpen = crossesMidnight
        ? nowMinutes >= openMinutes || nowMinutes < closeMinutes
        : nowMinutes >= openMinutes && nowMinutes < closeMinutes;

      if (!isOpen) return { isOpen: false, pastLastEntry: false };

      const lastEntryMinutes = toMinutes(w.lastEntry);
      if (lastEntryMinutes == null) return { isOpen: true, pastLastEntry: false };

      let pastLastEntry;
      if (!crossesMidnight) {
        pastLastEntry = nowMinutes >= lastEntryMinutes;
      } else if (lastEntryMinutes >= openMinutes) {
        // 最終受付も日をまたぐ営業時間の「前半」側にある場合
        pastLastEntry = nowMinutes >= lastEntryMinutes || nowMinutes < closeMinutes && nowMinutes < openMinutes;
      } else {
        // 最終受付が日をまたいだ後（当日側）にある場合
        pastLastEntry = nowMinutes >= lastEntryMinutes && nowMinutes < closeMinutes;
      }
      return { isOpen: true, pastLastEntry };
    }

    const evaluated = candidateWindows.map(evaluateWindow);
    const anyOpen = evaluated.some((r) => r.isOpen);

    if (!anyOpen) {
      return { label: "営業時間外", className: "status-closed-hours" };
    }

    // 現在営業中の時間帯が1つでも「まだ最終受付前」なら通常の営業中表示にする
    const anyOpenBeforeLastEntry = evaluated.some((r) => r.isOpen && !r.pastLastEntry);

    if (!anyOpenBeforeLastEntry) {
      return { label: "最終受付終了", className: "status-last-entry-over" };
    }

    return { label: "現在 営業中", className: "status-open" };
  }

  function renderDetailHTML(item) {
    const place = [item.prefecture, item.area]
      .filter(Boolean)
      .join(" ");

    const hours = item.is_24_hours
      ? "24時間営業"
      : item.open_time || item.close_time
      ? `${ft(item.open_time) || ""}${item.open_time || item.close_time ? "〜" : ""}${ft(item.close_time) || ""}`
      : "";

    const links = [
      item.website ? { label: "公式サイト", url: item.website } : null,
      item.instagram ? { label: "Instagram", url: item.instagram } : null,
      item.twitter ? { label: "X（旧Twitter）", url: item.twitter } : null,
      item.facebook ? { label: "Facebook", url: item.facebook } : null
    ].filter(Boolean);

    const status = getOpenStatus(item);

    const detailDestination =
      item.lat != null && item.lng != null ? `${item.lat},${item.lng}` : item.address || item.name;
    const detailDirectionsUrl = detailDestination
      ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(detailDestination)}`
      : null;

    return `
      <div class="detail-toolbar">
        <div class="detail-toolbar-row">
          <button type="button" id="detailBack" class="detail-back">← 一覧に戻る</button>
          <div class="detail-toolbar-right">
            <button type="button" id="detailReport" class="detail-action">⚠️ 報告する</button>
          </div>
        </div>
        <div class="detail-toolbar-actions">
          <button type="button" id="detailEdit" class="detail-action">✏️ 情報を編集する</button>
          <button type="button" id="detailShare" class="detail-action">↗️ 共有する</button>
          ${
            detailDirectionsUrl
              ? `<a href="${escapeHtml(detailDirectionsUrl)}" target="_blank" rel="noopener" class="detail-action detail-action-route detail-action-push-right">🚗 経路を確認する</a>`
              : ""
          }
        </div>
      </div>
      <div class="detail-heading-block">
        ${place ? `<p class="detail-location">📍 ${escapeHtml(place)}</p>` : ""}
        <h2>${escapeHtml(item.name || "名称未設定")}</h2>
        ${status ? `<span class="status-badge ${status.className}">${escapeHtml(status.label)}</span>` : ""}
        ${
          item.last_visit_date || item.last_info_check_date
            ? `<p class="detail-visit-dates">🗓 最終訪問日：${escapeHtml(item.last_visit_date || "未記録")}</p><p class="detail-visit-dates">🕒 最終情報確認日：${escapeHtml(item.last_info_check_date || "未記録")}</p>`
            : ""
        }
      </div>
      <div class="tab-bar" id="detailTabBar">
        <button type="button" class="tab-btn" data-tab-target="basic">基本情報</button>
        <button type="button" class="tab-btn" data-tab-target="price">料金・決済方法</button>
        <button type="button" class="tab-btn" data-tab-target="onsen">温泉情報</button>
        <button type="button" class="tab-btn" data-tab-target="facility-male">🚹 男性 浴場情報</button>
        <button type="button" class="tab-btn" data-tab-target="facility-female">🚺 女性 浴場情報</button>
        <button type="button" class="tab-btn" data-tab-target="sauna-male">🚹 男性 サウナ関連</button>
        <button type="button" class="tab-btn" data-tab-target="sauna-female">🚺 女性 サウナ関連</button>
        <button type="button" class="tab-btn" data-tab-target="amenity-male">🚹 男性 シャワー・アメニティ</button>
        <button type="button" class="tab-btn" data-tab-target="amenity-female">🚺 女性 シャワー・アメニティ</button>
        <button type="button" class="tab-btn" data-tab-target="locker-male">🚹 男性 ロッカー・靴箱</button>
        <button type="button" class="tab-btn" data-tab-target="locker-female">🚺 女性 ロッカー・靴箱</button>
        <button type="button" class="tab-btn" data-tab-target="toilet">トイレ・バリアフリー</button>
        <button type="button" class="tab-btn" data-tab-target="dining">お食事処・売店・自動販売機</button>
        <button type="button" class="tab-btn" data-tab-target="rest-massage">休憩スペース・マッサージ</button>
        <button type="button" class="tab-btn" data-tab-target="rental-misc">レンタルスペース・その他の施設</button>
        <button type="button" class="tab-btn" data-tab-target="parking">駐車場</button>
        <button type="button" class="tab-btn" data-tab-target="user">ユーザー情報・地図情報</button>
      </div>
      <div class="detail-body">

        <!-- 基本情報（営業時間・料金・公式SNS・メモを含む） -->
        <section class="detail-section" data-tab="basic">
          <h3>🏷️ 基本情報</h3>

          ${detailSubhead("🏢 施設業態")}
          ${renderBusinessTypeBadge(item.business_type)}

          <div class="detail-gap"></div>

          ${detailSubhead("📝 利用条件")}
          ${detailTags(item.usage) || `<p class="detail-note">情報がありません。</p>`}

          ${detailSubhead("📍 住所")}
          <p class="detail-note">${item.address ? escapeHtml(item.address) : "情報がありません。"}</p>

          ${detailSubhead("🚶‍♀️ アクセス方法")}
          ${
            item.nearest_station
              ? `${detailSubhead("🚉 最寄り駅")}<p class="detail-note">${escapeHtml(item.nearest_station)}</p>`
              : ""
          }
          <p class="detail-note">${item.access_method ? escapeHtml(item.access_method) : "情報がありません。"}</p>

          ${detailSubhead("📞 電話番号")}
          <p class="detail-note">${
            item.phone
              ? `<a class="detail-phone" href="tel:${escapeHtml(item.phone.replace(/[^0-9+]/g, ""))}">${escapeHtml(item.phone)}</a>`
              : "情報がありません。"
          }</p>

          <div class="detail-gap"></div>

          ${detailSubhead("🕒 営業時間")}
          <div class="detail-grid">
            ${detailField("営業時間", hours)}
            ${detailField("最終受付", ft(item.last_entry))}
          </div>
          ${
            item.weekday_hours_overrides && Object.keys(item.weekday_hours_overrides).length
              ? `<p class="detail-note">🗓 ${Object.entries(item.weekday_hours_overrides)
                  .map(([day, t]) => `${escapeHtml(day === "祝" ? "祝日" : `${day}曜`)}：${escapeHtml(ft(t.open) || "?")}〜${escapeHtml(ft(t.close) || "?")}${t.lastEntry ? `（最終受付${escapeHtml(ft(t.lastEntry))}）` : ""}`)
                  .join("　")}</p>`
              : ""
          }
          ${item.hours_note ? `<p class="detail-note">${escapeHtml(item.hours_note)}</p>` : ""}
          ${(() => {
            const daysSuffix = (days) =>
              Array.isArray(days) && days.length
                ? `（${days.map((d) => (d === "祝" ? "祝日" : `${d}曜`)).join("・")}）`
                : "";
            const lastEntrySuffix = (t) => (t ? `（最終受付${escapeHtml(ft(t))}）` : "");

            const additionalRows = (icon, label, parentDays, list) =>
              Array.isArray(list)
                ? list
                    .filter((w) => w.open || w.close)
                    .map((w) => {
                      const rowDays = Array.isArray(w.days) && w.days.length ? w.days : parentDays;
                      return `${icon} ${label}：${escapeHtml(ft(w.open) || "?")}〜${escapeHtml(ft(w.close) || "?")}${lastEntrySuffix(w.lastEntry)}${escapeHtml(daysSuffix(rowDays))}`;
                    })
                : [];

            const rows = [
              item.overnight_open_time || item.overnight_close_time
                ? `🛌 宿泊者限定：${escapeHtml(ft(item.overnight_open_time) || "?")}〜${escapeHtml(ft(item.overnight_close_time) || "?")}${lastEntrySuffix(item.overnight_last_entry)}${escapeHtml(daysSuffix(item.overnight_days))}`
                : null,
              ...additionalRows("🛌", "宿泊者限定", item.overnight_days, item.overnight_additional_hours),
              item.morning_bath_open_time || item.morning_bath_close_time
                ? `🌅 朝風呂：${escapeHtml(ft(item.morning_bath_open_time) || "?")}〜${escapeHtml(ft(item.morning_bath_close_time) || "?")}${lastEntrySuffix(item.morning_bath_last_entry)}${escapeHtml(daysSuffix(item.morning_bath_days))}`
                : null,
              ...additionalRows("🌅", "朝風呂", item.morning_bath_days, item.morning_bath_additional_hours),
              item.other_hours_open_time || item.other_hours_close_time
                ? `🕒 ${escapeHtml(item.other_hours_label || "その他の営業時間")}：${escapeHtml(ft(item.other_hours_open_time) || "?")}〜${escapeHtml(ft(item.other_hours_close_time) || "?")}${lastEntrySuffix(item.other_hours_last_entry)}${escapeHtml(daysSuffix(item.other_hours_days))}`
                : null,
              ...additionalRows(
                "🕒",
                item.other_hours_label || "その他の営業時間",
                item.other_hours_days,
                item.other_hours_additional_hours
              )
            ].filter(Boolean);

            return rows.map((r) => `<p class="detail-note">${r}</p>`).join("");
          })()}

          ${detailSubhead("🗓 定休日")}
          ${(() => {
            const closedTags = getClosedDayTags(item);

            return closedTags.length
              ? detailTags(closedTags)
              : `<p class="detail-note">情報がありません。</p>`;
          })()}
          ${item.closed_days_note ? `<p class="detail-note">${escapeHtml(item.closed_days_note)}</p>` : ""}
          ${item.closed_holiday_rule ? `<p class="detail-note">🎌 ${escapeHtml(item.closed_holiday_rule)}</p>` : ""}
          ${item.closed_day_pattern_note ? `<p class="detail-note">${escapeHtml(item.closed_day_pattern_note)}</p>` : ""}
          ${item.is_temp_closed && item.temp_closed_detail ? `<p class="detail-note">${escapeHtml(item.temp_closed_detail)}</p>` : ""}

          ${
            item.notice_info || item.event_info
              ? `
                ${detailSubhead("📢 お知らせ・イベント情報")}
                ${item.notice_info ? `<p class="field-title">📢 施設からのお知らせ情報</p><p class="detail-note">${escapeHtml(item.notice_info)}</p>` : ""}
                ${item.event_info ? `<p class="field-title">📢 イベント情報・期間限定情報</p><p class="detail-note">${escapeHtml(item.event_info)}</p>` : ""}
              `
              : ""
          }

          ${
            links.length
              ? `
                ${detailSubhead("📱 公式情報・SNS")}
                <div class="detail-links">
                  ${links
                    .map(
                      (l) =>
                        `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`
                    )
                    .join("")}
                </div>
              `
              : ""
          }

          ${
            item.note
              ? `
                ${detailSubhead("メモ・施設紹介")}
                <p class="detail-note">${escapeHtml(item.note)}</p>
              `
              : ""
          }
        </section>

        <!-- 料金（入浴料・その他料金区分・決済方法など） -->
        <section class="detail-section" data-tab="price">
          <h3>💰 料金・決済方法</h3>

          ${detailSubhead("♨️ 入浴料")}
          ${renderFeeList(item.bath_fees)}

          <div class="detail-gap"></div>

          ${detailSubhead("🔁 回数券")}
          ${renderTicketFeeList(item.ticket_fees)}

          <div class="detail-gap"></div>

          ${detailSubhead("♿️ 障がい者料金")}
          ${renderFeeList(item.disability_fees)}
          ${item.disability_fee_note ? `<p class="detail-note">${escapeHtml(item.disability_fee_note)}</p>` : ""}

          <div class="detail-gap"></div>

          ${detailSubhead("✨️ 会員優待")}
          ${renderBenefitList(item.member_benefits)}

          <div class="detail-gap"></div>

          ${detailSubhead("🎫 優待券")}
          ${renderBenefitList(item.special_coupons)}

          ${item.discount_supplementary_note ? `<p class="detail-note">${escapeHtml(item.discount_supplementary_note)}</p>` : ""}

          <div class="detail-gap"></div>

          ${detailSubhead("🧖‍♀️ その他料金区分")}
          ${renderFeeList(item.other_fees)}

          <div class="detail-gap"></div>

          ${detailSubhead("💳 購入方法")}
          ${detailTags(item.purchase_method) || `<p class="detail-note-tight">情報がありません。</p>`}

          ${detailSubhead("👛 決済方法")}
          ${
            detailTags(item.payment) ||
            `<p class="detail-note-tight">情報がありません。</p>`
          }

          ${detailSubhead("💳 ポイントカード")}
          <p class="detail-note-tight">${escapeHtml(item.point_card || "不明")}</p>

          ${detailSubhead("🪪 会員証")}
          <p class="detail-note-tight">${escapeHtml(item.membership_card || "不明")}</p>

          ${detailSubhead("⌚️ リストバンド決済")}
          <p class="detail-note-tight">${escapeHtml(item.wristband_payment || "不明")}</p>

          ${
            item.price_note
              ? `<div class="detail-gap"></div><p class="field-title">補足</p><p class="detail-note">${escapeHtml(item.price_note)}</p>`
              : ""
          }
        </section>

        <!-- 施設情報（浴場・浴槽） -->
        <section class="detail-section" data-tab="facility-male">
          <h3>🚹 男性 浴場情報</h3>

          ${detailSubhead("♨️ 浴場・浴槽の形状")}
          ${detailTags(item.bath_shape_male) || `<p class="detail-note-tight">情報がありません。</p>`}

          ${detailSubhead("🛀 浴槽の機能・種類")}
          ${detailTags(item.bath_function_male) || `<p class="detail-note-tight">情報がありません。</p>`}

          ${detailSubhead("👨‍👩‍👧‍👦 家族風呂・貸切風呂の詳細情報")}
          <div class="detail-grid">
            ${detailField("時間", item.private_bath_duration_male != null ? `${item.private_bath_duration_male}分` : "")}
            ${detailField(
              "👤 定員",
              item.private_bath_capacity_status_male === "人数あり" && item.private_bath_capacity_male != null
                ? `${item.private_bath_capacity_male}人`
                : item.private_bath_capacity_status_male || ""
            )}
          </div>
          ${item.private_bath_note_male ? `<p class="detail-note">${escapeHtml(item.private_bath_note_male)}</p>` : ""}

          ${detailSubhead("♨️ 浴場の場所")}
          ${detailTags(item.bath_location_male) || `<p class="detail-note-tight">情報がありません。</p>`}

          ${detailSubhead("🛀 浴場内の手すり")}
          <p class="detail-note-tight">${escapeHtml(item.bath_handrail_male || "不明")}</p>

          ${detailSubhead("🪣 洗面用具置き")}
          <p class="detail-note-tight">${escapeHtml(item.toiletry_shelf_male || "不明")}</p>

          ${detailSubhead("♨️ 浴場前室")}
          <p class="detail-note-tight">${escapeHtml(item.bath_anteroom_male || "不明")}</p>

          ${detailSubhead("♨️ 浴場・浴槽内の期間限定イベント")}
          <p class="detail-note-tight">${escapeHtml(item.bath_event_male || "不明")}</p>
          ${item.bath_event_detail_male ? `<p class="detail-note">${escapeHtml(item.bath_event_detail_male)}</p>` : ""}

          ${detailSubhead("♨️ 浴槽内の小物（ゆず、あひる等）")}
          <p class="detail-note-tight">${escapeHtml(item.bath_toys_male || "不明")}</p>
          ${item.bath_toys_detail_male ? `<p class="detail-note">${escapeHtml(item.bath_toys_detail_male)}</p>` : ""}

          ${
            item.bath_note_male
              ? `${detailSubhead("♨️ その他 浴場・浴槽の補足事項")}<p class="detail-note">${escapeHtml(item.bath_note_male)}</p>`
              : ""
          }
        </section>
        <section class="detail-section" data-tab="facility-female">
          <h3>🚺 女性 浴場情報</h3>

          ${detailSubhead("♨️ 浴場・浴槽の形状")}
          ${detailTags(item.bath_shape_female) || `<p class="detail-note-tight">情報がありません。</p>`}

          ${detailSubhead("🛀 浴槽の機能・種類")}
          ${detailTags(item.bath_function_female) || `<p class="detail-note-tight">情報がありません。</p>`}

          ${detailSubhead("👨‍👩‍👧‍👦 家族風呂・貸切風呂の詳細情報")}
          <div class="detail-grid">
            ${detailField("時間", item.private_bath_duration_female != null ? `${item.private_bath_duration_female}分` : "")}
            ${detailField(
              "👤 定員",
              item.private_bath_capacity_status_female === "人数あり" && item.private_bath_capacity_female != null
                ? `${item.private_bath_capacity_female}人`
                : item.private_bath_capacity_status_female || ""
            )}
          </div>
          ${item.private_bath_note_female ? `<p class="detail-note">${escapeHtml(item.private_bath_note_female)}</p>` : ""}

          ${detailSubhead("♨️ 浴場の場所")}
          ${detailTags(item.bath_location_female) || `<p class="detail-note-tight">情報がありません。</p>`}

          ${detailSubhead("🛀 浴場内の手すり")}
          <p class="detail-note-tight">${escapeHtml(item.bath_handrail_female || "不明")}</p>

          ${detailSubhead("🪣 洗面用具置き")}
          <p class="detail-note-tight">${escapeHtml(item.toiletry_shelf_female || "不明")}</p>

          ${detailSubhead("♨️ 浴場前室")}
          <p class="detail-note-tight">${escapeHtml(item.bath_anteroom_female || "不明")}</p>

          ${detailSubhead("♨️ 浴場・浴槽内の期間限定イベント")}
          <p class="detail-note-tight">${escapeHtml(item.bath_event_female || "不明")}</p>
          ${item.bath_event_detail_female ? `<p class="detail-note">${escapeHtml(item.bath_event_detail_female)}</p>` : ""}

          ${detailSubhead("♨️ 浴槽内の小物（ゆず、あひる等）")}
          <p class="detail-note-tight">${escapeHtml(item.bath_toys_female || "不明")}</p>
          ${item.bath_toys_detail_female ? `<p class="detail-note">${escapeHtml(item.bath_toys_detail_female)}</p>` : ""}

          ${
            item.bath_note_female
              ? `${detailSubhead("♨️ その他 浴場・浴槽の補足事項")}<p class="detail-note">${escapeHtml(item.bath_note_female)}</p>`
              : ""
          }
        </section>


        <!-- 温泉情報 -->
        <section class="detail-section" data-tab="onsen">
          <h3>♨️ 温泉情報</h3>

          ${detailSubhead("♨️ 泉質")}
          ${detailTags(item.spring_types) || `<p class="detail-note-tight">情報がありません。</p>`}

          ${detailSubhead("✨️ 温泉の適応症・効能")}
          ${detailTags(item.indications) || `<p class="detail-note-tight">情報がありません。</p>`}

          ${detailSubhead("♨️ 温泉の状態・特徴")}
          <p class="field-subtitle">💧 温泉の色</p>
          ${detailTags(item.spring_color) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">👃 温泉の匂い</p>
          ${detailTags(item.spring_smell) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">🫧 温泉の感触・肌触り</p>
          ${detailTags(item.spring_texture) || `<p class="detail-note-tight">情報がありません。</p>`}

          ${detailSubhead("🛀 温泉の利用状況")}
          <div class="detail-grid">
            ${detailField("源泉掛け流し", item.source_free_flow)}
            ${detailField("加水", item.spring_dilution)}
            ${detailField("加温", item.spring_heating)}
            ${detailField("循環", item.spring_circulation)}
            ${detailField("消毒", item.spring_disinfection)}
          </div>
          ${item.spring_usage_note ? `<p class="detail-note">${escapeHtml(item.spring_usage_note)}</p>` : ""}

          <div class="detail-grid">
            ${detailField("🌡 泉温", item.spring_temperature != null ? `${item.spring_temperature}℃` : "")}
            ${detailField("🌡 源泉温度", item.source_temperature != null ? `${item.source_temperature}℃` : "")}
            ${detailField("🚰 pH", item.spring_ph)}
            ${detailField("♨️ 源泉名・温泉地名", item.spring_source_name)}
            ${detailField("♨️ 開湯年", item.spring_open_year)}
          </div>
          ${item.spring_open_year_note ? `<p class="detail-note">${escapeHtml(item.spring_open_year_note)}</p>` : ""}

          ${detailSubhead("🔍 水質検査等の情報")}
          <div class="detail-grid">
            ${detailField("🧪 温泉成分分析", item.spring_analysis)}
            ${detailField("分析年月日", item.spring_analysis_date)}
            ${detailField("🦠 レジオネラ属菌検査", item.legionella_test)}
            ${detailField("分析年月日", item.legionella_test_date)}
            ${detailField("検査結果", item.legionella_result)}
          </div>
          <p class="field-subtitle">📃 情報源</p>
          ${detailTags(item.spring_info_source) || `<p class="detail-note-tight">情報がありません。</p>`}
          <div class="detail-gap"></div>
          <div class="detail-grid">${detailField("👀 情報確認日", item.spring_info_check_date)}</div>

          ${detailSubhead("👦🏻 子どもの混浴制度")}
          <div class="detail-grid">
            ${detailField("混浴制度", item.child_mixed_bathing)}
            ${detailField("→ 年齢制限", item.child_age_limit)}
            ${detailField("→ 性別による制限", item.child_gender_limit)}
            ${detailField("👦🏻 男児", item.child_boy_age_limit != null ? `${item.child_boy_age_limit}歳以下` : "")}
            ${detailField("👧🏻 女児", item.child_girl_age_limit != null ? `${item.child_girl_age_limit}歳以下` : "")}
          </div>
          ${item.child_mixed_bathing_note ? `<p class="detail-note">${escapeHtml(item.child_mixed_bathing_note)}</p>` : ""}
          <p class="field-subtitle">📃 情報源</p>
          ${detailTags(item.child_info_source) || `<p class="detail-note-tight">情報がありません。</p>`}
          <div class="detail-gap"></div>
          <div class="detail-grid">${detailField("👀 情報確認日", item.child_info_check_date)}</div>
        </section>


        <!-- サウナ関連 -->
        <section class="detail-section" data-tab="sauna-male">
          <h3>🚹 男性 サウナ関連</h3>

          ${detailSubhead("🧖‍♀️ サウナ設備")}
          <div class="detail-grid">
            ${detailField("🧖‍♀️ サウナ設備", item.sauna_facility_male)}
            ${detailField("🧖‍♀️ サウナ設備の場所", item.sauna_facility_location_male)}
          </div>
          ${item.sauna_facility_suspended_male ? `<p class="detail-note">⚠️ 現在休止中</p>` : ""}
          <p class="field-title">🧖‍♀️ サウナの種類</p>
          ${detailTags(item.sauna_types_male) || `<p class="detail-note-tight">情報がありません。</p>`}

          <p class="field-subtitle">🕒 サウナの利用時間</p>
          <p class="detail-note-tight">${escapeHtml(item.sauna_hours_type_male || "不明")}</p>
          ${
            item.sauna_hours_type_male === "利用時間あり"
              ? `
                <div class="detail-grid">
                  ${detailField(
                    "平日",
                    item.sauna_hours_weekday_open_male || item.sauna_hours_weekday_close_male
                      ? `${ft(item.sauna_hours_weekday_open_male) || "?"}〜${ft(item.sauna_hours_weekday_close_male) || "?"}`
                      : ""
                  )}
                  ${detailField(
                    "土曜日",
                    item.sauna_hours_saturday_open_male || item.sauna_hours_saturday_close_male
                      ? `${ft(item.sauna_hours_saturday_open_male) || "?"}〜${ft(item.sauna_hours_saturday_close_male) || "?"}`
                      : ""
                  )}
                  ${detailField(
                    "日曜日",
                    item.sauna_hours_sunday_open_male || item.sauna_hours_sunday_close_male
                      ? `${ft(item.sauna_hours_sunday_open_male) || "?"}〜${ft(item.sauna_hours_sunday_close_male) || "?"}`
                      : ""
                  )}
                  ${detailField(
                    "祝日",
                    item.sauna_hours_holiday_open_male || item.sauna_hours_holiday_close_male
                      ? `${ft(item.sauna_hours_holiday_open_male) || "?"}〜${ft(item.sauna_hours_holiday_close_male) || "?"}`
                      : ""
                  )}
                </div>
              `
              : ""
          }

          ${detailSubhead("🌡 サウナ室の仕様")}
          <div class="detail-grid">
            ${detailField(
              "🌡 サウナ室内の温度",
              item.sauna_temp_min_male != null || item.sauna_temp_max_male != null
                ? `${item.sauna_temp_min_male ?? "?"}℃〜${item.sauna_temp_max_male ?? "?"}℃`
                : ""
            )}
            ${detailField(
              "💧 サウナ室内の湿度",
              item.sauna_humidity_min_male != null || item.sauna_humidity_max_male != null
                ? `${item.sauna_humidity_min_male ?? "?"}%〜${item.sauna_humidity_max_male ?? "?"}%`
                : ""
            )}
            ${detailField("👤 サウナ室内の定員", item.sauna_capacity_number_male != null ? `${item.sauna_capacity_number_male}人` : "")}
            ${detailField("定員の目安", item.sauna_capacity_range_male)}
            ${detailField("🌡 温度計・湿度計", item.sauna_thermometer_male)}
            ${detailField("🕒 時計（現在時刻表示）", item.sauna_clock_male)}
            ${detailField("🕒 12分計", item.sauna_twelve_min_timer_male)}
            ${detailField("⏳ 砂時計", item.sauna_hourglass_male)}
            ${detailField("📺 テレビ", item.sauna_tv_male)}
            ${detailField("📺 テレビリモコン", item.sauna_tv_remote_male)}
            ${detailField("🚨 サウナ室内の非常ボタン", item.sauna_emergency_button_male)}
            ${detailField("🪨 サウナストーン", item.sauna_stones_male)}
            ${detailField("🔥 ストーブタイプ", item.sauna_stove_type_male)}
            ${detailField(
              "→ ストーブの台数",
              item.sauna_stove_count_status_male === "台数あり" && item.sauna_stove_count_male != null
                ? `${item.sauna_stove_count_male}台`
                : item.sauna_stove_count_status_male || ""
            )}
            ${detailField("ストーブの製品名・メーカー", item.sauna_stove_brand_male)}
          </div>

          ${detailSubhead("🧖‍♀️ サウナマット・用品")}
          <div class="detail-grid">
            ${detailField("🧖‍♀️ サウナマットの貸し出し", item.sauna_mat_rental_male)}
            ${detailField("🧖‍♀️ サウナ用品のレンタル", item.sauna_goods_rental_male)}
            ${detailField("🧖‍♀️ サウナ用品の販売（施設内）", item.sauna_goods_sale_male)}
          </div>
          ${item.sauna_mat_rental_male === "あり" ? `<p class="field-title">→ サウナマットの種類</p>` : ""}
          ${detailTags(item.sauna_mat_type_male)}
          ${item.sauna_mat_rental_male === "あり" ? `<p class="field-title">→ サウナマットの設置場所・利用方法</p>` : ""}
          ${detailTags(item.sauna_mat_placement_male)}

          ${detailSubhead("🔥 ロウリュ・アウフグース")}
          <div class="detail-grid">
            ${detailField("🔥 ロウリュ", item.sauna_loyly_male)}
            ${detailField("→ アロマロウリュ", item.sauna_aroma_loyly_male)}
            ${detailField("アロマの種類", item.sauna_aroma_type_male)}
            ${detailField("→ アウフグース・熱波", item.sauna_aufguss_male)}
            ${detailField("→ 開催頻度", item.sauna_loyly_frequency_male)}
            ${detailField("開催時間", item.sauna_loyly_interval_minutes_male != null ? `${item.sauna_loyly_interval_minutes_male}分おき` : "")}
            ${detailField("→ 予約", item.sauna_loyly_reservation_male)}
          </div>
          ${item.sauna_loyly_male === "あり" ? `<p class="field-title">→ ロウリュの種類</p>` : ""}
          ${detailTags(item.sauna_loyly_type_male)}
          ${item.sauna_loyly_interval_note_male ? `<p class="detail-note">${escapeHtml(item.sauna_loyly_interval_note_male)}</p>` : ""}
          ${item.sauna_loyly_note_male ? `<p class="detail-note">${escapeHtml(item.sauna_loyly_note_male)}</p>` : ""}

          ${detailSubhead("🚪 サウナ室の出入り・照明")}
          <div class="detail-grid">
            ${detailField("🚪 サウナ室のドア", item.sauna_door_type_male)}
            ${detailField("🚪 サウナ室内から出る際", item.sauna_exit_direction_male)}
            ${detailField("💡 照明の明るさ", item.sauna_light_brightness_male)}
          </div>
          ${item.sauna_room_note_male ? `<p class="detail-note">${escapeHtml(item.sauna_room_note_male)}</p>` : ""}

          ${detailSubhead("💧 水風呂")}
          <div class="detail-grid">
            ${detailField("💧 水風呂", item.cold_bath_availability_male)}
            ${detailField("💧 水風呂の個数", item.cold_bath_count_male != null ? `${item.cold_bath_count_male}個` : "")}
            ${detailField(
              "🌡 水風呂の温度",
              item.cold_bath_temp_min_male != null || item.cold_bath_temp_max_male != null
                ? `${item.cold_bath_temp_min_male ?? "?"}℃〜${item.cold_bath_temp_max_male ?? "?"}℃`
                : ""
            )}
            ${detailField("👤 水風呂の定員", item.cold_bath_capacity_male != null ? `${item.cold_bath_capacity_male}人` : "")}
            ${detailField("💧 水風呂の深さ", item.cold_bath_depth_male != null ? `およそ${item.cold_bath_depth_male}cm` : "")}
            ${detailField("🚿 冷水シャワー", item.cold_shower_male)}
          </div>
          <p class="field-subtitle">💧 水風呂の形状</p>
          ${detailTags(item.cold_bath_shape_male) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">💧 水風呂の設置場所</p>
          ${detailTags(item.cold_bath_location_male) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">💧 水風呂の水源</p>
          ${detailTags(item.cold_bath_source_male) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">💧 水風呂の冷却方法</p>
          ${detailTags(item.cold_bath_cooling_male) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">💧 水風呂の水流</p>
          ${detailTags(item.cold_bath_flow_male) || `<p class="detail-note-tight">情報がありません。</p>`}
          ${item.cold_bath_note_male ? `<p class="detail-note">${escapeHtml(item.cold_bath_note_male)}</p>` : ""}

          ${detailSubhead("🌿 外気浴・内気浴")}
          <div class="detail-grid">
            ${detailField("🌿 外気浴", item.outdoor_male)}
            ${detailField("🌿 内気浴", item.indoor_bathing_male)}
          </div>
          ${item.outdoor_male === "あり" ? `<p class="field-subtitle">→ 外気浴の設置場所</p>` : ""}
          ${detailTags(item.outdoor_location_male)}
          ${item.indoor_bathing_male === "あり" ? `<p class="field-subtitle">→ 内気浴の設置場所</p>` : ""}
          ${detailTags(item.indoor_location_male)}

          ${detailSubhead("🪑 ととのい椅子・設備")}
          <div class="detail-grid">
            ${detailField("🪑 ととのい椅子", item.tori_toi_chair_male)}
            ${detailField("ととのい椅子の数", item.tori_toi_chair_count_male != null ? `${item.tori_toi_chair_count_male}脚` : "")}
            ${detailField("🪑 リクライニングチェア", item.recline_chair_male)}
            ${detailField("リクライニングチェアの数", item.recline_chair_count_male != null ? `${item.recline_chair_count_male}脚` : "")}
            ${detailField("🪑 インフィニティチェア", item.infinity_chair_male)}
            ${detailField("インフィニティチェアの数", item.infinity_chair_count_male != null ? `${item.infinity_chair_count_male}脚` : "")}
            ${detailField("🪑 ベンチ", item.bench_male)}
            ${detailField("ベンチの数", item.bench_count_male != null ? `${item.bench_count_male}脚` : "")}
            ${detailField("🪑 デッキチェア", item.deck_chair_male)}
            ${detailField("デッキチェアの数", item.deck_chair_count_male != null ? `${item.deck_chair_count_male}脚` : "")}
            ${detailField("🌿 寝ころびスペース", item.laying_space_male)}
          </div>
          ${item.laying_space_male === "あり" ? `<p class="field-title">→ 材質</p>` : ""}
          ${detailTags(item.laying_space_material_male)}
          ${item.tori_toi_other_note_male ? `<p class="detail-note">${escapeHtml(item.tori_toi_other_note_male)}</p>` : ""}

          ${detailSubhead("🏠 環境")}
          <div class="detail-grid">
            ${detailField("🏠 屋根・雨対策", item.roof_rain_protection_male)}
            ${detailField("☀️ 日なた・日陰", item.sun_shade_male)}
          </div>
          <p class="field-subtitle">🏞️ 景色・景観</p>
          ${detailTags(item.scenery_male) || `<p class="detail-note-tight">情報がありません。</p>`}

          ${item.outdoor_indoor_note_male ? `<p class="detail-note">${escapeHtml(item.outdoor_indoor_note_male)}</p>` : ""}
        </section>
        <section class="detail-section" data-tab="sauna-female">
          <h3>🚺 女性 サウナ関連</h3>

          ${detailSubhead("🧖‍♀️ サウナ設備")}
          <div class="detail-grid">
            ${detailField("🧖‍♀️ サウナ設備", item.sauna_facility_female)}
            ${detailField("🧖‍♀️ サウナ設備の場所", item.sauna_facility_location_female)}
          </div>
          ${item.sauna_facility_suspended_female ? `<p class="detail-note">⚠️ 現在休止中</p>` : ""}
          <p class="field-title">🧖‍♀️ サウナの種類</p>
          ${detailTags(item.sauna_types_female) || `<p class="detail-note-tight">情報がありません。</p>`}

          <p class="field-subtitle">🕒 サウナの利用時間</p>
          <p class="detail-note-tight">${escapeHtml(item.sauna_hours_type_female || "不明")}</p>
          ${
            item.sauna_hours_type_female === "利用時間あり"
              ? `
                <div class="detail-grid">
                  ${detailField(
                    "平日",
                    item.sauna_hours_weekday_open_female || item.sauna_hours_weekday_close_female
                      ? `${ft(item.sauna_hours_weekday_open_female) || "?"}〜${ft(item.sauna_hours_weekday_close_female) || "?"}`
                      : ""
                  )}
                  ${detailField(
                    "土曜日",
                    item.sauna_hours_saturday_open_female || item.sauna_hours_saturday_close_female
                      ? `${ft(item.sauna_hours_saturday_open_female) || "?"}〜${ft(item.sauna_hours_saturday_close_female) || "?"}`
                      : ""
                  )}
                  ${detailField(
                    "日曜日",
                    item.sauna_hours_sunday_open_female || item.sauna_hours_sunday_close_female
                      ? `${ft(item.sauna_hours_sunday_open_female) || "?"}〜${ft(item.sauna_hours_sunday_close_female) || "?"}`
                      : ""
                  )}
                  ${detailField(
                    "祝日",
                    item.sauna_hours_holiday_open_female || item.sauna_hours_holiday_close_female
                      ? `${ft(item.sauna_hours_holiday_open_female) || "?"}〜${ft(item.sauna_hours_holiday_close_female) || "?"}`
                      : ""
                  )}
                </div>
              `
              : ""
          }

          ${detailSubhead("🌡 サウナ室の仕様")}
          <div class="detail-grid">
            ${detailField(
              "🌡 サウナ室内の温度",
              item.sauna_temp_min_female != null || item.sauna_temp_max_female != null
                ? `${item.sauna_temp_min_female ?? "?"}℃〜${item.sauna_temp_max_female ?? "?"}℃`
                : ""
            )}
            ${detailField(
              "💧 サウナ室内の湿度",
              item.sauna_humidity_min_female != null || item.sauna_humidity_max_female != null
                ? `${item.sauna_humidity_min_female ?? "?"}%〜${item.sauna_humidity_max_female ?? "?"}%`
                : ""
            )}
            ${detailField("👤 サウナ室内の定員", item.sauna_capacity_number_female != null ? `${item.sauna_capacity_number_female}人` : "")}
            ${detailField("定員の目安", item.sauna_capacity_range_female)}
            ${detailField("🌡 温度計・湿度計", item.sauna_thermometer_female)}
            ${detailField("🕒 時計（現在時刻表示）", item.sauna_clock_female)}
            ${detailField("🕒 12分計", item.sauna_twelve_min_timer_female)}
            ${detailField("⏳ 砂時計", item.sauna_hourglass_female)}
            ${detailField("📺 テレビ", item.sauna_tv_female)}
            ${detailField("📺 テレビリモコン", item.sauna_tv_remote_female)}
            ${detailField("🚨 サウナ室内の非常ボタン", item.sauna_emergency_button_female)}
            ${detailField("🪨 サウナストーン", item.sauna_stones_female)}
            ${detailField("🔥 ストーブタイプ", item.sauna_stove_type_female)}
            ${detailField(
              "→ ストーブの台数",
              item.sauna_stove_count_status_female === "台数あり" && item.sauna_stove_count_female != null
                ? `${item.sauna_stove_count_female}台`
                : item.sauna_stove_count_status_female || ""
            )}
            ${detailField("ストーブの製品名・メーカー", item.sauna_stove_brand_female)}
          </div>

          ${detailSubhead("🧖‍♀️ サウナマット・用品")}
          <div class="detail-grid">
            ${detailField("🧖‍♀️ サウナマットの貸し出し", item.sauna_mat_rental_female)}
            ${detailField("🧖‍♀️ サウナ用品のレンタル", item.sauna_goods_rental_female)}
            ${detailField("🧖‍♀️ サウナ用品の販売（施設内）", item.sauna_goods_sale_female)}
          </div>
          ${item.sauna_mat_rental_female === "あり" ? `<p class="field-title">→ サウナマットの種類</p>` : ""}
          ${detailTags(item.sauna_mat_type_female)}
          ${item.sauna_mat_rental_female === "あり" ? `<p class="field-title">→ サウナマットの設置場所・利用方法</p>` : ""}
          ${detailTags(item.sauna_mat_placement_female)}

          ${detailSubhead("🔥 ロウリュ・アウフグース")}
          <div class="detail-grid">
            ${detailField("🔥 ロウリュ", item.sauna_loyly_female)}
            ${detailField("→ アロマロウリュ", item.sauna_aroma_loyly_female)}
            ${detailField("アロマの種類", item.sauna_aroma_type_female)}
            ${detailField("→ アウフグース・熱波", item.sauna_aufguss_female)}
            ${detailField("→ 開催頻度", item.sauna_loyly_frequency_female)}
            ${detailField("開催時間", item.sauna_loyly_interval_minutes_female != null ? `${item.sauna_loyly_interval_minutes_female}分おき` : "")}
            ${detailField("→ 予約", item.sauna_loyly_reservation_female)}
          </div>
          ${item.sauna_loyly_female === "あり" ? `<p class="field-title">→ ロウリュの種類</p>` : ""}
          ${detailTags(item.sauna_loyly_type_female)}
          ${item.sauna_loyly_interval_note_female ? `<p class="detail-note">${escapeHtml(item.sauna_loyly_interval_note_female)}</p>` : ""}
          ${item.sauna_loyly_note_female ? `<p class="detail-note">${escapeHtml(item.sauna_loyly_note_female)}</p>` : ""}

          ${detailSubhead("🚪 サウナ室の出入り・照明")}
          <div class="detail-grid">
            ${detailField("🚪 サウナ室のドア", item.sauna_door_type_female)}
            ${detailField("🚪 サウナ室内から出る際", item.sauna_exit_direction_female)}
            ${detailField("💡 照明の明るさ", item.sauna_light_brightness_female)}
          </div>
          ${item.sauna_room_note_female ? `<p class="detail-note">${escapeHtml(item.sauna_room_note_female)}</p>` : ""}

          ${detailSubhead("💧 水風呂")}
          <div class="detail-grid">
            ${detailField("💧 水風呂", item.cold_bath_availability_female)}
            ${detailField("💧 水風呂の個数", item.cold_bath_count_female != null ? `${item.cold_bath_count_female}個` : "")}
            ${detailField(
              "🌡 水風呂の温度",
              item.cold_bath_temp_min_female != null || item.cold_bath_temp_max_female != null
                ? `${item.cold_bath_temp_min_female ?? "?"}℃〜${item.cold_bath_temp_max_female ?? "?"}℃`
                : ""
            )}
            ${detailField("👤 水風呂の定員", item.cold_bath_capacity_female != null ? `${item.cold_bath_capacity_female}人` : "")}
            ${detailField("💧 水風呂の深さ", item.cold_bath_depth_female != null ? `およそ${item.cold_bath_depth_female}cm` : "")}
            ${detailField("🚿 冷水シャワー", item.cold_shower_female)}
          </div>
          <p class="field-subtitle">💧 水風呂の形状</p>
          ${detailTags(item.cold_bath_shape_female) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">💧 水風呂の設置場所</p>
          ${detailTags(item.cold_bath_location_female) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">💧 水風呂の水源</p>
          ${detailTags(item.cold_bath_source_female) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">💧 水風呂の冷却方法</p>
          ${detailTags(item.cold_bath_cooling_female) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">💧 水風呂の水流</p>
          ${detailTags(item.cold_bath_flow_female) || `<p class="detail-note-tight">情報がありません。</p>`}
          ${item.cold_bath_note_female ? `<p class="detail-note">${escapeHtml(item.cold_bath_note_female)}</p>` : ""}

          ${detailSubhead("🌿 外気浴・内気浴")}
          <div class="detail-grid">
            ${detailField("🌿 外気浴", item.outdoor_female)}
            ${detailField("🌿 内気浴", item.indoor_bathing_female)}
          </div>
          ${item.outdoor_female === "あり" ? `<p class="field-subtitle">→ 外気浴の設置場所</p>` : ""}
          ${detailTags(item.outdoor_location_female)}
          ${item.indoor_bathing_female === "あり" ? `<p class="field-subtitle">→ 内気浴の設置場所</p>` : ""}
          ${detailTags(item.indoor_location_female)}

          ${detailSubhead("🪑 ととのい椅子・設備")}
          <div class="detail-grid">
            ${detailField("🪑 ととのい椅子", item.tori_toi_chair_female)}
            ${detailField("ととのい椅子の数", item.tori_toi_chair_count_female != null ? `${item.tori_toi_chair_count_female}脚` : "")}
            ${detailField("🪑 リクライニングチェア", item.recline_chair_female)}
            ${detailField("リクライニングチェアの数", item.recline_chair_count_female != null ? `${item.recline_chair_count_female}脚` : "")}
            ${detailField("🪑 インフィニティチェア", item.infinity_chair_female)}
            ${detailField("インフィニティチェアの数", item.infinity_chair_count_female != null ? `${item.infinity_chair_count_female}脚` : "")}
            ${detailField("🪑 ベンチ", item.bench_female)}
            ${detailField("ベンチの数", item.bench_count_female != null ? `${item.bench_count_female}脚` : "")}
            ${detailField("🪑 デッキチェア", item.deck_chair_female)}
            ${detailField("デッキチェアの数", item.deck_chair_count_female != null ? `${item.deck_chair_count_female}脚` : "")}
            ${detailField("🌿 寝ころびスペース", item.laying_space_female)}
          </div>
          ${item.laying_space_female === "あり" ? `<p class="field-title">→ 材質</p>` : ""}
          ${detailTags(item.laying_space_material_female)}
          ${item.tori_toi_other_note_female ? `<p class="detail-note">${escapeHtml(item.tori_toi_other_note_female)}</p>` : ""}

          ${detailSubhead("🏠 環境")}
          <div class="detail-grid">
            ${detailField("🏠 屋根・雨対策", item.roof_rain_protection_female)}
            ${detailField("☀️ 日なた・日陰", item.sun_shade_female)}
          </div>
          <p class="field-subtitle">🏞️ 景色・景観</p>
          ${detailTags(item.scenery_female) || `<p class="detail-note-tight">情報がありません。</p>`}

          ${item.outdoor_indoor_note_female ? `<p class="detail-note">${escapeHtml(item.outdoor_indoor_note_female)}</p>` : ""}
        </section>

        <!-- シャワー -->
        <section class="detail-section" data-tab="amenity-male">
          <h3>🚹 男性 シャワー</h3>
          <div class="detail-grid">
            ${detailField("🚿 シャワーの数", item.shower_count_male)}
          </div>
          <p class="field-subtitle">🚿 シャワーの種類</p>
          ${detailTags(item.shower_type_male) || `<p class="detail-note-tight">情報がありません。</p>`}
          <div class="detail-gap"></div>
          <div class="detail-grid">
            ${detailField("🚿 シャワーヘッドの種類・メーカー等", item.shower_head_info_male)}
            ${detailField("🚰 吐水口・カラン", item.shower_faucet_male)}
            ${detailField("🚿 シャワーブース", item.shower_booth_male)}
            ${detailField("🚿 洗い場仕切り", item.wash_area_divider_male)}
            ${detailField("🗑 くず入れ（浴場内）", item.bath_trash_bin_male)}
            ${detailField("🚿 かけ湯", item.pre_rinse_water_male)}
          </div>
          ${item.shower_note_male ? `<p class="detail-note">${escapeHtml(item.shower_note_male)}</p>` : ""}
        </section>

        <!-- アメニティ -->
        <section class="detail-section" data-tab="amenity-male">
          <h3>🚹 男性 アメニティ・備品</h3>
          <div class="detail-grid">
            ${detailField("🧴 シャンプー・コンディショナー", item.shampoo_conditioner_male)}
            ${detailField("🧴 ボディソープ", item.body_soap_male)}
            ${detailField("🧼 石鹸", item.soap_male)}
            ${detailField("🧴 洗顔フォーム（浴場内）", item.face_wash_male)}
            ${detailField("🧴 クレンジング（浴場内）", item.cleansing_male)}
            ${detailField("🪣 洗面器・桶", item.basin_male)}
            ${detailField("🪑 浴場内の椅子", item.bath_chair_male)}
            ${detailField("🪑 シャワーチェア", item.shower_chair_male)}
            ${detailField("🔌 ドライヤー", item.dryer_status_male)}
            ${detailField("ドライヤーの個数", item.dryer_count_male)}
            ${detailField("ドライヤー使用料金", item.dryer_fee_male)}
            ${detailField("ドライヤーの種類・メーカー", item.dryer_brand_male)}
            ${detailField("ドライヤー持ち込み", item.dryer_bring_own_male)}
            ${detailField("🪥 ティッシュ", item.tissue_male)}
            ${detailField("🪥 綿棒", item.cotton_swab_male)}
            ${detailField("🪥 化粧品", item.cosmetics_male)}
            ${detailField("🪥 ヘアゴム", item.hair_tie_male)}
            ${detailField("💄 パウダールーム", item.powder_room_male)}
            ${detailField("💄 洗面台", item.vanity_male)}
            ${detailField("🚰 冷水機", item.water_cooler_male)}
            ${detailField("🔌 扇風機", item.fan_male)}
            ${detailField("🌡 体重計・体脂肪計", item.scale_male)}
            ${detailField("🌡 血圧計", item.blood_pressure_monitor_male)}
            ${detailField("🗑 ごみ箱", item.trash_bin_male)}
            ${detailField("🪑 更衣室内の椅子", item.locker_room_chair_male)}
            ${detailField("👶🏻 ベビーチェア", item.baby_chair_male)}
            ${detailField("👶🏻 ベビーベッド", item.baby_bed_male)}
          </div>
          ${
            Array.isArray(item.rental_items_male) && item.rental_items_male.length
              ? `
                <p class="field-title">🧴 レンタル品</p>
                <ul class="rental-list">
                  ${item.rental_items_male.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}
                </ul>
              `
              : ""
          }
          ${item.amenity_note_male ? `<p class="detail-note">${escapeHtml(item.amenity_note_male)}</p>` : ""}
        </section>
        <section class="detail-section" data-tab="amenity-female">
          <h3>🚺 女性 シャワー</h3>
          <div class="detail-grid">
            ${detailField("🚿 シャワーの数", item.shower_count_female)}
          </div>
          <p class="field-subtitle">🚿 シャワーの種類</p>
          ${detailTags(item.shower_type_female) || `<p class="detail-note-tight">情報がありません。</p>`}
          <div class="detail-gap"></div>
          <div class="detail-grid">
            ${detailField("🚿 シャワーヘッドの種類・メーカー等", item.shower_head_info_female)}
            ${detailField("🚰 吐水口・カラン", item.shower_faucet_female)}
            ${detailField("🚿 シャワーブース", item.shower_booth_female)}
            ${detailField("🚿 洗い場仕切り", item.wash_area_divider_female)}
            ${detailField("🗑 くず入れ（浴場内）", item.bath_trash_bin_female)}
            ${detailField("🚿 かけ湯", item.pre_rinse_water_female)}
          </div>
          ${item.shower_note_female ? `<p class="detail-note">${escapeHtml(item.shower_note_female)}</p>` : ""}
        </section>

        <!-- アメニティ -->
        <section class="detail-section" data-tab="amenity-female">
          <h3>🚺 女性 アメニティ・備品</h3>
          <div class="detail-grid">
            ${detailField("🧴 シャンプー・コンディショナー", item.shampoo_conditioner_female)}
            ${detailField("🧴 ボディソープ", item.body_soap_female)}
            ${detailField("🧼 石鹸", item.soap_female)}
            ${detailField("🧴 洗顔フォーム（浴場内）", item.face_wash_female)}
            ${detailField("🧴 クレンジング（浴場内）", item.cleansing_female)}
            ${detailField("🪣 洗面器・桶", item.basin_female)}
            ${detailField("🪑 浴場内の椅子", item.bath_chair_female)}
            ${detailField("🪑 シャワーチェア", item.shower_chair_female)}
            ${detailField("🔌 ドライヤー", item.dryer_status_female)}
            ${detailField("ドライヤーの個数", item.dryer_count_female)}
            ${detailField("ドライヤー使用料金", item.dryer_fee_female)}
            ${detailField("ドライヤーの種類・メーカー", item.dryer_brand_female)}
            ${detailField("ドライヤー持ち込み", item.dryer_bring_own_female)}
            ${detailField("🪥 ティッシュ", item.tissue_female)}
            ${detailField("🪥 綿棒", item.cotton_swab_female)}
            ${detailField("🪥 化粧品", item.cosmetics_female)}
            ${detailField("🪥 ヘアゴム", item.hair_tie_female)}
            ${detailField("💄 パウダールーム", item.powder_room_female)}
            ${detailField("💄 洗面台", item.vanity_female)}
            ${detailField("🚰 冷水機", item.water_cooler_female)}
            ${detailField("🔌 扇風機", item.fan_female)}
            ${detailField("🌡 体重計・体脂肪計", item.scale_female)}
            ${detailField("🌡 血圧計", item.blood_pressure_monitor_female)}
            ${detailField("🗑 ごみ箱", item.trash_bin_female)}
            ${detailField("🪑 更衣室内の椅子", item.locker_room_chair_female)}
            ${detailField("👶🏻 ベビーチェア", item.baby_chair_female)}
            ${detailField("👶🏻 ベビーベッド", item.baby_bed_female)}
          </div>
          ${
            Array.isArray(item.rental_items_female) && item.rental_items_female.length
              ? `
                <p class="field-title">🧴 レンタル品</p>
                <ul class="rental-list">
                  ${item.rental_items_female.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}
                </ul>
              `
              : ""
          }
          ${item.amenity_note_female ? `<p class="detail-note">${escapeHtml(item.amenity_note_female)}</p>` : ""}
        </section>

        <!-- ロッカー -->
        <section class="detail-section" data-tab="locker-male">
          <h3>🚹 男性 ロッカー</h3>
          <div class="detail-grid">
            ${detailField("🔐 ロッカー数", item.locker_count_male)}
          </div>
          <p class="field-subtitle">🔐 ロッカーキーの仕組み</p>
          ${detailTags(item.locker_key_type_male) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">⌚️ リストバンドの種類</p>
          ${detailTags(item.locker_wristband_type_male) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">⌚️ リストバンド用途</p>
          ${detailTags(item.locker_wristband_use_male) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">🔐 ロッカーの大きさ</p>
          ${detailTags(item.locker_size_male) || `<p class="detail-note-tight">情報がありません。</p>`}
          <div class="detail-gap"></div>
          <div class="detail-grid">
            ${detailField("🔐 ロッカー内の仕切り・2段タイプ", item.locker_divider_male)}
            ${detailField("👕 ロッカー内のハンガー", item.locker_hanger_male)}
            ${detailField("📱 ロッカー内の小物入れ", item.locker_small_item_box_male)}
            ${detailField("🔑 貴重品預け用ロッカー", item.locker_valuables_male)}
            ${detailField("🔐 レンタルロッカー", item.locker_rental_male)}
            ${detailField("👜 キャリーケース預け", item.locker_suitcase_male)}
          </div>
          ${item.locker_note_male ? `<p class="detail-note">${escapeHtml(item.locker_note_male)}</p>` : ""}
        </section>

        <!-- 靴箱 -->
        <section class="detail-section" data-tab="locker-male">
          <h3>🚹 男性 靴箱</h3>
          <div class="detail-grid">
            ${detailField("👟 靴箱数", item.shoebox_count_male)}
            ${detailField("🪙 利用料金", item.shoebox_fee_male)}
          </div>
          <p class="field-subtitle">👟 靴箱の仕組み</p>
          ${detailTags(item.shoebox_type_male) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">🔐 靴箱の鍵の仕組み</p>
          ${detailTags(item.shoebox_key_type_male) || `<p class="detail-note-tight">情報がありません。</p>`}
          ${item.shoebox_note_male ? `<p class="detail-note">${escapeHtml(item.shoebox_note_male)}</p>` : ""}
        </section>
        <section class="detail-section" data-tab="locker-female">
          <h3>🚺 女性 ロッカー</h3>
          <div class="detail-grid">
            ${detailField("🔐 ロッカー数", item.locker_count_female)}
          </div>
          <p class="field-subtitle">🔐 ロッカーキーの仕組み</p>
          ${detailTags(item.locker_key_type_female) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">⌚️ リストバンドの種類</p>
          ${detailTags(item.locker_wristband_type_female) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">⌚️ リストバンド用途</p>
          ${detailTags(item.locker_wristband_use_female) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">🔐 ロッカーの大きさ</p>
          ${detailTags(item.locker_size_female) || `<p class="detail-note-tight">情報がありません。</p>`}
          <div class="detail-gap"></div>
          <div class="detail-grid">
            ${detailField("🔐 ロッカー内の仕切り・2段タイプ", item.locker_divider_female)}
            ${detailField("👕 ロッカー内のハンガー", item.locker_hanger_female)}
            ${detailField("📱 ロッカー内の小物入れ", item.locker_small_item_box_female)}
            ${detailField("🔑 貴重品預け用ロッカー", item.locker_valuables_female)}
            ${detailField("🔐 レンタルロッカー", item.locker_rental_female)}
            ${detailField("👜 キャリーケース預け", item.locker_suitcase_female)}
          </div>
          ${item.locker_note_female ? `<p class="detail-note">${escapeHtml(item.locker_note_female)}</p>` : ""}
        </section>

        <!-- 靴箱 -->
        <section class="detail-section" data-tab="locker-female">
          <h3>🚺 女性 靴箱</h3>
          <div class="detail-grid">
            ${detailField("👟 靴箱数", item.shoebox_count_female)}
            ${detailField("🪙 利用料金", item.shoebox_fee_female)}
          </div>
          <p class="field-subtitle">👟 靴箱の仕組み</p>
          ${detailTags(item.shoebox_type_female) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">🔐 靴箱の鍵の仕組み</p>
          ${detailTags(item.shoebox_key_type_female) || `<p class="detail-note-tight">情報がありません。</p>`}
          ${item.shoebox_note_female ? `<p class="detail-note">${escapeHtml(item.shoebox_note_female)}</p>` : ""}
        </section>

        <!-- トイレ・バリアフリー -->
        <section class="detail-section" data-tab="toilet">
          <h3>🚻 トイレ・バリアフリー</h3>

          <p class="field-subtitle">🚻 トイレの設置場所</p>
          <div class="detail-grid">
            ${detailField("💁 ロビー・受付", item.toilet_location_lobby)}
            ${detailField("🚹 男性更衣室内のトイレ", item.toilet_mens_changing_room)}
            ${detailField("🚺 女性更衣室内のトイレ", item.toilet_womens_changing_room)}
          </div>
          ${item.toilet_location_other ? `<p class="detail-note">${escapeHtml(item.toilet_location_other)}</p>` : ""}

          <p class="field-subtitle">🚽 トイレの種類</p>
          ${detailTags(item.toilet_types) || `<p class="detail-note-tight">情報がありません。</p>`}

          <div class="detail-gap"></div>

          <div class="detail-grid">
            ${detailField("♿️ 身障者用・多目的トイレ", item.toilet_accessible)}
            ${detailField("♿️ 車椅子対応トイレ", item.toilet_wheelchair)}
            ${detailField("♿️ オストメイト対応トイレ", item.toilet_ostomate)}
            ${detailField("👶🏻 おむつ交換台", item.toilet_diaper_table)}
            ${detailField("👶🏻 ベビーチェア", item.toilet_baby_chair_in_toilet)}
          </div>

          <div class="detail-gap"></div>

          <div class="detail-grid detail-grid-large">
            ${detailField("♿️ スロープ", item.toilet_slope)}
            ${detailField("🛗 エレベーター・エスカレーター", item.toilet_elevator)}
          </div>
          ${item.toilet_barrier_free_note ? `<p class="detail-note">${escapeHtml(item.toilet_barrier_free_note)}</p>` : ""}
        </section>


        <!-- お食事処・売店・自動販売機 -->
        <section class="detail-section" data-tab="dining">
          <h3>🛋 お食事処・売店・自動販売機</h3>

          <div class="detail-grid">
            ${detailField("🍴 お食事処", item.restaurant_status)}
          </div>
          <p class="field-subtitle">🍴 お食事処の種類</p>
          ${detailTags(item.restaurant_types) || `<p class="detail-note-tight">情報がありません。</p>`}
          ${item.restaurant_feature ? `<p class="detail-note">${escapeHtml(item.restaurant_feature)}</p>` : ""}
          <div class="detail-gap"></div>
          <div class="detail-grid">
            ${detailField("🕒 営業時間（お食事処）", item.restaurant_hours_type)}
          </div>
          ${
            item.restaurant_hours_type === "営業時間あり"
              ? `<div class="detail-grid">
                  ${detailField("開店時間", ft(item.restaurant_open_time))}
                  ${detailField("閉店時間", ft(item.restaurant_close_time))}
                  ${detailField("ラストオーダー", item.restaurant_last_order)}
                </div>`
              : ""
          }
          <p class="field-subtitle">💴 決済方法（お食事処）</p>
          ${detailTags(item.restaurant_payment) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">🍺 その他の情報</p>
          ${detailTags(item.restaurant_other_info) || `<p class="detail-note-tight">情報がありません。</p>`}
          ${item.restaurant_note ? `<p class="detail-note">${escapeHtml(item.restaurant_note)}</p>` : ""}

          <div class="detail-gap"></div>

          <div class="detail-grid">
            ${detailField("🥤 自動販売機", item.vending_machine_status)}
            ${detailField("🚮 リサイクルボックス", item.recycle_box_status)}
          </div>
          <p class="field-subtitle">🥤 自動販売機の種類</p>
          ${detailTags(item.vending_machine_types) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">🥤 設置場所</p>
          ${detailTags(item.vending_machine_location) || `<p class="detail-note-tight">情報がありません。</p>`}
          ${item.vending_machine_note ? `<p class="detail-note">${escapeHtml(item.vending_machine_note)}</p>` : ""}

          <div class="detail-gap"></div>

          <div class="detail-grid">
            ${detailField("🛍 売店コーナー", item.shop_status)}
            ${detailField("🕒 営業時間（売店）", item.shop_hours_type)}
          </div>
          ${
            item.shop_hours_type === "利用時間あり"
              ? `<div class="detail-grid">
                  ${detailField("開始", ft(item.shop_hours_open))}
                  ${detailField("終了", ft(item.shop_hours_close))}
                </div>`
              : ""
          }
          <p class="field-subtitle">🛍 売店コーナーの品揃え</p>
          ${detailTags(item.shop_items) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">💴 決済方法（売店）</p>
          ${detailTags(item.shop_payment) || `<p class="detail-note-tight">情報がありません。</p>`}
          ${item.shop_note ? `<p class="detail-note">${escapeHtml(item.shop_note)}</p>` : ""}
        </section>

        <!-- 休憩スペース・マッサージ -->
        <section class="detail-section" data-tab="rest-massage">
          <h3>🛋 休憩スペース・マッサージ</h3>

          <div class="detail-grid">
            ${detailField("🛋 休憩スペース", item.rest_space_status)}
            ${detailField("🛋 利用条件", item.rest_space_condition)}
            ${detailField("🪙 利用料金", item.rest_space_fee_type)}
            ${detailField("別料金", item.rest_space_fee_amount != null ? `${item.rest_space_fee_amount}円` : "")}
          </div>
          <p class="field-subtitle">🛋 休憩スペースの形式</p>
          ${detailTags(item.rest_space_type) || `<p class="detail-note-tight">情報がありません。</p>`}
          <div class="detail-gap"></div>
          <div class="detail-grid">
            ${detailField("🕒 利用時間（休憩スペース）", item.rest_space_hours_type)}
          </div>
          ${
            item.rest_space_hours_type === "利用時間あり"
              ? `<div class="detail-grid">
                  ${detailField("開始", ft(item.rest_space_hours_open))}
                  ${detailField("終了", ft(item.rest_space_hours_close))}
                </div>`
              : ""
          }
          <div class="detail-gap"></div>
          <div class="detail-grid">
            ${detailField(
              "1人あたりの利用時間",
              item.rest_space_per_person_type === "時間指定" && item.rest_space_per_person_minutes != null
                ? `${item.rest_space_per_person_minutes}分`
                : item.rest_space_per_person_type || ""
            )}
          </div>
          ${item.rest_space_note ? `<p class="detail-note">${escapeHtml(item.rest_space_note)}</p>` : ""}

          <div class="detail-gap"></div>

          <div class="detail-grid">
            ${detailField("💆‍♀️ マッサージ・リラクゼーション施設", item.massage_status)}
          </div>
          <p class="field-subtitle">💆‍♀️ マッサージ・リラクゼーション施設の種類</p>
          ${detailTags(item.massage_types) || `<p class="detail-note-tight">情報がありません。</p>`}
          ${
            Array.isArray(item.massage_menu_fees) && item.massage_menu_fees.length
              ? `<p class="field-title">💴 料金</p>
                <ul class="rental-list">
                  ${item.massage_menu_fees
                    .map(
                      (f) =>
                        `<li>${escapeHtml(f.name)}：${f.minutes != null ? `${f.minutes}分` : "?"}${f.price != null ? `${f.price}円` : "?円"}</li>`
                    )
                    .join("")}
                </ul>`
              : ""
          }
          <div class="detail-gap"></div>
          <div class="detail-grid">
            ${detailField("🕒 営業時間（マッサージ）", item.massage_hours_type)}
          </div>
          ${
            item.massage_hours_type === "営業時間あり"
              ? `<div class="detail-grid">
                  ${detailField("開始", ft(item.massage_hours_open))}
                  ${detailField("終了", ft(item.massage_hours_close))}
                </div>`
              : ""
          }
          <div class="detail-gap"></div>
          <div class="detail-grid">
            ${detailField("💆‍♀️ マッサージチェア", item.massage_chair_status)}
            ${detailField("設置台数", item.massage_chair_count != null ? `${item.massage_chair_count}台` : "")}
            ${detailField(
              "時間・料金",
              item.massage_chair_minutes != null || item.massage_chair_price != null
                ? `${item.massage_chair_minutes ?? "?"}分 ${item.massage_chair_price ?? "?"}円`
                : ""
            )}
          </div>
          ${item.massage_note ? `<p class="detail-note">${escapeHtml(item.massage_note)}</p>` : ""}
        </section>

        <!-- レンタルスペース・その他の施設 -->
        <section class="detail-section" data-tab="rental-misc">
          <h3>🛋 レンタルスペース・その他の施設</h3>

          <div class="detail-grid">
            ${detailField("💬 レンタルスペース", item.rental_space_status)}
            ${detailField("👩🏻‍💻 コワーキングスペース", item.coworking_space_status)}
          </div>
          <p class="field-subtitle">👩🏻‍💻 レンタル・コワーキングスペースの特徴</p>
          ${detailTags(item.coworking_features) || `<p class="detail-note-tight">情報がありません。</p>`}
          ${item.coworking_note ? `<p class="detail-note">${escapeHtml(item.coworking_note)}</p>` : ""}

          <div class="detail-gap"></div>

          <div class="detail-grid">
            ${detailField("🛌 宿泊施設", item.accommodation_status)}
            ${detailField("🏊 プール", item.pool_facility_status)}
            ${detailField("🎮 ゲームコーナー", item.game_corner_status)}
            ${detailField("👧🏻 キッズコーナー", item.kids_corner_status)}
            ${detailField("☀️ 屋外施設", item.outdoor_facility_status)}
            ${detailField("♨️ 足湯", item.foot_bath_status)}
            ${detailField("🪨 岩盤浴", item.ganbanyoku_status)}
            ${detailField("🧺 コインランドリー", item.coin_laundry_status)}
            ${detailField("🚰 源泉持ち帰り", item.spring_takeaway_status)}
            ${detailField("🥚 温泉たまご", item.onsen_tamago_status)}
            ${detailField("🛜 Wi-Fi", item.wifi_facility)}
            ${detailField(
              "Wi-Fi利用時間・料金",
              item.wifi_fee_minutes != null || item.wifi_fee_price != null
                ? `${item.wifi_fee_minutes ?? "?"}分 ${item.wifi_fee_price ?? "?"}円`
                : ""
            )}
            ${detailField("🔌 充電スポット", item.charging_spot)}
            ${detailField(
              "充電利用時間・料金",
              item.charging_fee_minutes != null || item.charging_fee_price != null
                ? `${item.charging_fee_minutes ?? "?"}分 ${item.charging_fee_price ?? "?"}円`
                : ""
            )}
            ${detailField("🚑 AED", item.aed_facility_status)}
            ${detailField("🏥 救護室", item.first_aid_room_status)}
          </div>
          ${item.other_facility_note ? `<p class="detail-note">${escapeHtml(item.other_facility_note)}</p>` : ""}
        </section>

        <!-- 駐車場・駐輪場 -->
        <section class="detail-section" data-tab="parking">
          <h3>🅿️ 駐車場・駐輪場</h3>
          <div class="detail-grid">
            ${detailField("🅿️ 駐車場", item.parking_status)}
            ${detailField("🅿️ 駐車可能台数", item.parking_capacity)}
            ${detailField("💰 駐車料金", item.parking_fee_type)}
            ${detailField("料金", item.parking_fee_amount != null ? `${item.parking_fee_amount}円` : "")}
          </div>
          <p class="field-subtitle">🆓 利用条件</p>
          ${detailTags(item.parking_conditions) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">🅿️ 駐車場の種類</p>
          ${detailTags(item.parking_types) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-subtitle">♿️ バリアフリー・大型車対応</p>
          ${detailTags(item.parking_accessible) || `<p class="detail-note-tight">情報がありません。</p>`}
          <div class="detail-gap"></div>
          <div class="detail-grid">
            ${detailField("🚗 多忙期の臨時駐車場", item.parking_temporary)}
            ${detailField("🏍 バイク駐車場", item.motorcycle_parking)}
            ${detailField("🚲 駐輪場", item.bicycle_parking)}
          </div>
          ${item.parking_note ? `<p class="detail-note">${escapeHtml(item.parking_note)}</p>` : ""}
        </section>

        <!-- ユーザー情報 -->
        <section class="detail-section" data-tab="user">
          <h3>⭐️ ユーザー情報</h3>
          <p class="field-subtitle">✍️ 情報源</p>
          ${detailTags(item.user_info_source) || `<p class="detail-note-tight">情報がありません。</p>`}
          <p class="field-title">⭐️ 評価</p>
          ${(() => {
            const summary = window.__ratingSummary?.[item.id];
            return summary && summary.count
              ? `<p class="detail-note">⭐️ ${summary.average.toFixed(1)}　${summary.count}件の評価</p>`
              : `<p class="detail-note-tight">まだ評価がありません。</p>`;
          })()}
          <p class="field-title">📝 みんなの感想</p>
          <div id="onsenReviewsList" class="reviews-list"><p class="detail-note-tight">読み込んでいます…</p></div>
        </section>

        <!-- 地図情報 -->
        ${
          item.lat != null || item.lng != null || item.google_maps_url
            ? `
              <section class="detail-section" data-tab="user">
                <h3>地図情報</h3>
                <div class="detail-grid">
                  ${detailField("緯度", item.lat)}
                  ${detailField("経度", item.lng)}
                </div>
                <p class="detail-links">
                  ${
                    item.google_maps_url || (item.lat != null && item.lng != null)
                      ? `<a href="${
                          item.google_maps_url
                            ? escapeHtml(item.google_maps_url)
                            : `https://www.google.com/maps?q=${escapeHtml(item.lat)},${escapeHtml(item.lng)}`
                        }" target="_blank" rel="noopener">Googleマップで見る</a>`
                      : ""
                  }
                </p>
              </section>
            `
            : ""
        }

      </div>
    `;
  }

  function switchDetailTab(tabKey) {
    document.querySelectorAll('.detail-section[data-tab]').forEach((section) => {
      section.classList.toggle("tab-active", section.dataset.tab === tabKey);
    });
    document.querySelectorAll("#detailTabBar .tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tabTarget === tabKey);
    });
    const detailView = $("detailView");
    if (detailView) detailView.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  function normalizeNameForMatch(str) {
    return String(str || "")
      .toLowerCase()
      .replace(/[\s　]+/g, "");
  }

  function findSimilarNamedOnsens(query) {
    const normalizedQuery = normalizeNameForMatch(query);
    if (normalizedQuery.length < 2 || !Array.isArray(window.__onsenData)) return [];

    return window.__onsenData
      .filter((item) => {
        const normalizedName = normalizeNameForMatch(item.name);
        if (!normalizedName) return false;
        return normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName);
      })
      .slice(0, 5);
  }

  function renderDuplicateNameSuggestions(candidates) {
    const box = $("duplicateNameSuggestions");
    if (!box) return;

    if (!candidates.length) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }

    box.innerHTML = `
      <p>もしかして…この施設ですか？</p>
      ${candidates
        .map(
          (item) =>
            `<button type="button" class="duplicate-suggestion-item" data-id="${escapeHtml(item.id ?? "")}">${escapeHtml(item.name || "名称未設定")}${item.prefecture ? `（${escapeHtml(item.prefecture)}${escapeHtml(item.area || "")}）` : ""}</button>`
        )
        .join("")}
      <button type="button" class="duplicate-suggestion-dismiss" id="dismissDuplicateSuggestions">いいえ、このまま新しく追加する</button>
    `;
    box.classList.remove("hidden");

    box.querySelectorAll(".duplicate-suggestion-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        box.classList.add("hidden");
        closeModal();
        location.hash = `#detail-${btn.dataset.id}`;
      });
    });
    $("dismissDuplicateSuggestions")?.addEventListener("click", () => {
      box.classList.add("hidden");
      box.innerHTML = "";
    });
  }

  async function showDetail(id) {
    const listView = $("listView");
    const detailView = $("detailView");
    if (!detailView) return;

    listView?.classList.add("hidden");
    $("mapSection")?.classList.add("hidden");
    $("siteHeader")?.classList.add("hidden");
    $("heroSection")?.classList.add("hidden");
    $("homeScrollToTopButton")?.classList.add("hidden");
    detailView.classList.remove("hidden");
    detailView.innerHTML = `<div class="detail-empty">読み込んでいます…</div>`;
    window.scrollTo(0, 0);

    const item = await fetchItemById(id);

    if (!item) {
      detailView.innerHTML = `
        <div class="detail-empty">
          この温泉は見つかりませんでした。
          <p><button type="button" id="detailBack" class="detail-back">← 一覧に戻る</button></p>
        </div>
      `;
      $("detailBack")?.addEventListener("click", () => {
        location.hash = "";
      });
      return;
    }

    detailView.innerHTML = renderDetailHTML(item);
    loadOnsenReviews(item.id);

    document.querySelectorAll("#detailTabBar .tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchDetailTab(btn.dataset.tabTarget));
    });
    switchDetailTab("basic");

    $("detailBack")?.addEventListener("click", () => {
      location.hash = "";
    });

    $("detailEdit")?.addEventListener("click", () => {
      editingId = item.id;

      const draft = getDraft();
      let resumed = false;

      if (draft && draft.mode === "edit" && String(draft.editingId) === String(item.id)) {
        const savedAtText = draft.savedAt
          ? new Date(draft.savedAt).toLocaleString("ja-JP")
          : "";
        const ok = confirm(
          `この施設について、入力途中の内容が残っています（${savedAtText}）。\n続きから編集を再開しますか？\n\n` +
          "「キャンセル」を押すと、この下書きは削除されます。"
        );
        if (ok) {
          resetForm();
          populateForm(draft.data);
          resumed = true;
        } else {
          clearDraft();
        }
      }

      if (!resumed) {
        resetForm();
        populateForm(item);
      }

      const modal = $("modal");
      if (modal) {
        modal.classList.remove("hidden");
        modal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
      }
      switchFormTab(resumed ? draft.activeTab || "basic" : "basic");

      const titleEl = $("modalTitle");
      if (titleEl) titleEl.textContent = "温泉を編集";

      loadMyRatingForOnsen(item.id);

      const submitButton = document.querySelector('#form button[type="submit"]');
      if (submitButton) submitButton.textContent = "更新する";
    });

    $("detailShare")?.addEventListener("click", async () => {
      const shareData = {
        title: item.name || "ゆのしるべ",
        text: `${item.name || "温泉情報"}の詳細ページ`,
        url: location.href
      };

      if (navigator.share) {
        try {
          await navigator.share(shareData);
        } catch (error) {
          // ユーザーによるキャンセル等は無視
        }
        return;
      }

      try {
        await navigator.clipboard.writeText(location.href);
        alert("リンクをコピーしました。");
      } catch (error) {
        console.error("共有リンクのコピーに失敗:", error);
      }
    });

    $("detailReport")?.addEventListener("click", () => {
      if ($("reportModalTarget")) {
        $("reportModalTarget").textContent = `「${item.name || "この施設"}」について報告します。`;
      }
      $("reportModal")?.classList.remove("hidden");
      $("reportModal")?.setAttribute("aria-hidden", "false");
      document.body.classList.add("modal-open");

      const submitHandler = async () => {
        if (!supabaseClient) {
          alert("現在この機能は利用できません（Supabase未設定）。");
          return;
        }
        const btn = $("reportSubmit");
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "送信中…";
        try {
          const { error } = await supabaseClient.from("reports").insert([
            {
              onsen_id: String(item.id).startsWith("local-") ? null : item.id,
              onsen_name: item.name || null,
              reason: value("reportReason"),
              message: value("reportMessage").trim() || null
            }
          ]);
          if (error) throw error;
          closeReportModal();
          alert("報告を送信しました。ご協力ありがとうございます。");
        } catch (error) {
          alert(`送信できませんでした。\n\n詳細：${error.message || "不明なエラー"}`);
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      };

      function closeReportModal() {
        $("reportModal")?.classList.add("hidden");
        $("reportModal")?.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
        if ($("reportMessage")) $("reportMessage").value = "";
        $("reportSubmit")?.removeEventListener("click", submitHandler);
        $("reportClose")?.removeEventListener("click", closeReportModal);
        $("reportCancel")?.removeEventListener("click", closeReportModal);
      }

      $("reportSubmit")?.addEventListener("click", submitHandler);
      $("reportClose")?.addEventListener("click", closeReportModal);
      $("reportCancel")?.addEventListener("click", closeReportModal);
    });
  }

  function renderAreaFacilityCard(item, extraButtonHtml = "") {
    const { outlineStyle, badgesHtml } = getUsageBadgesAndOutline(item);
    const status = getOpenStatus(item);
    const hoursText = item.is_24_hours
      ? "24時間営業"
      : item.open_time || item.close_time
      ? `${ft(item.open_time) || "?"}〜${ft(item.close_time) || "?"}`
      : "";
    const closedDaysText = getClosedDayTags(item).join("・");
    const priceParts = Array.isArray(item.bath_fees)
      ? item.bath_fees
          .filter((f) => f.category && f.amount != null && f.amount !== "")
          .map((f) => `${f.category} ${f.amount}円`)
      : [];

    return `
      <div class="area-facility-card" style="${outlineStyle}">
        ${badgesHtml}
        <div class="area-facility-card-body">
          <h3>${escapeHtml(item.name || "名称未設定")}</h3>
          <div class="card-badges">
            ${item.business_type ? renderBusinessTypeBadge(item.business_type) : ""}
            ${status ? `<span class="status-badge ${status.className}">${escapeHtml(status.label)}</span>` : ""}
          </div>
          ${hoursText ? `<p>🕒 営業時間：${escapeHtml(hoursText)}</p>` : ""}
          ${closedDaysText ? `<p>📅 定休日：${escapeHtml(closedDaysText)}</p>` : ""}
          ${priceParts.length ? `<p class="card-price">💰 料金：${escapeHtml(priceParts.join("　"))}</p>` : ""}
        </div>
        <button type="button" class="area-facility-detail-btn" data-id="${escapeHtml(item.id ?? "")}">温泉詳細</button>
        ${extraButtonHtml}
      </div>
    `;
  }

  let areasPageData = [];
  let areasFilterState = { prefectures: [], cities: [] };

  async function showAreasPage() {
    const listView = $("listView");
    const areasView = $("areasView");
    if (!areasView) return;

    listView?.classList.add("hidden");
    $("mapSection")?.classList.add("hidden");
    $("siteHeader")?.classList.add("hidden");
    $("heroSection")?.classList.add("hidden");
    $("homeScrollToTopButton")?.classList.add("hidden");
    $("detailView")?.classList.add("hidden");
    areasView.classList.remove("hidden");
    areasView.innerHTML = `<div class="detail-empty">読み込んでいます…</div>`;
    window.scrollTo(0, 0);

    if (!supabaseClient) {
      areasView.innerHTML = `
        <div class="detail-toolbar"><button type="button" id="areasBack" class="detail-back">← 一覧に戻る</button></div>
        <div class="detail-empty">この機能はSupabase未設定のため利用できません。</div>
      `;
      $("areasBack")?.addEventListener("click", () => {
        location.hash = "";
      });
      return;
    }

    try {
      const { data: areas, error } = await supabaseClient
        .from("onsen_areas")
        .select("*")
        .order("display_order", { ascending: true });
      if (error) throw error;

      const facilityById = {};
      (window.__onsenData || []).forEach((f) => {
        facilityById[f.id] = f;
      });

      // 温泉地ごとに、実在する施設だけを紐づける
      areasPageData = (areas || [])
        .map((area) => ({
          ...area,
          facilities: (area.facility_ids || []).map((id) => facilityById[id]).filter(Boolean)
        }))
        .filter((area) => area.facilities.length);

      areasFilterState = { prefectures: [], cities: [] };

      areasView.innerHTML = `
        <div class="detail-toolbar">
          <button type="button" id="areasBack" class="detail-back">← 一覧に戻る</button>
        </div>
        <div class="areas-page-body">
          <h1>♨️ 各地の温泉地まとめ</h1>
          <button type="button" id="openAreasFilterButton" class="filter-open-button">🔎 温泉地を絞り込む</button>
          <p id="areasFilterStatus" class="detail-note-tight hidden"></p>
          <div id="areasContent"></div>
        </div>
      `;

      $("areasBack")?.addEventListener("click", () => {
        location.hash = "";
      });
      $("openAreasFilterButton")?.addEventListener("click", openAreasFilterModal);

      renderAreasPageContent();
    } catch (error) {
      console.error(error);
      areasView.innerHTML = `
        <div class="detail-toolbar"><button type="button" id="areasBack" class="detail-back">← 一覧に戻る</button></div>
        <div class="detail-empty">読み込みに失敗しました。</div>
      `;
      $("areasBack")?.addEventListener("click", () => {
        location.hash = "";
      });
    }
  }

  const PREFECTURE_ORDER = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県",
    "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県",
    "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"
  ];

  function renderAreasPageContent() {
    const content = $("areasContent");
    if (!content) return;

    const filtered = areasPageData.filter((area) => {
      if (areasFilterState.prefectures.length && !areasFilterState.prefectures.includes(area.prefecture || "")) {
        return false;
      }
      if (areasFilterState.cities.length && !areasFilterState.cities.includes(area.area || "")) {
        return false;
      }
      return true;
    });

    const statusEl = $("areasFilterStatus");
    const filterActive = areasFilterState.prefectures.length > 0 || areasFilterState.cities.length > 0;
    if (statusEl) {
      statusEl.classList.toggle("hidden", !filterActive);
      statusEl.textContent = filterActive ? `🔎 絞り込み中：${filtered.length}件の温泉地を表示中です` : "";
    }

    // 都道府県 → 地方区分 → 市区町村 の階層でグループ化
    const prefMap = {};
    const regionOrderMap = {};
    filtered.forEach((area) => {
      const pref = area.prefecture || "";
      const region = area.region || "";
      const city = area.area || "";
      if (!prefMap[pref]) prefMap[pref] = {};
      if (!prefMap[pref][region]) prefMap[pref][region] = {};
      if (!prefMap[pref][region][city]) prefMap[pref][region][city] = [];
      prefMap[pref][region][city].push(area);

      const regionKey = `${pref}__${region}`;
      const order = Number(area.region_order) || 0;
      if (!(regionKey in regionOrderMap) || order < regionOrderMap[regionKey]) {
        regionOrderMap[regionKey] = order;
      }
    });

    const prefectures = Object.keys(prefMap).sort(
      (a, b) => PREFECTURE_ORDER.indexOf(a) - PREFECTURE_ORDER.indexOf(b)
    );

    content.innerHTML =
      prefectures
        .map((pref) => {
          const regions = Object.keys(prefMap[pref]).sort((a, b) => {
            const orderDiff = regionOrderMap[`${pref}__${a}`] - regionOrderMap[`${pref}__${b}`];
            if (orderDiff !== 0) return orderDiff;
            return a.localeCompare(b, "ja");
          });
          const cityOrder = window.MUNICIPALITIES_BY_PREFECTURE?.[pref] || [];

          const regionsHtml = regions
            .map((region) => {
              const cityMap = prefMap[pref][region];
              const cities = Object.keys(cityMap).sort((a, b) => {
                const ai = cityOrder.indexOf(a);
                const bi = cityOrder.indexOf(b);
                if (ai === -1 && bi === -1) return a.localeCompare(b, "ja");
                if (ai === -1) return 1;
                if (bi === -1) return -1;
                return ai - bi;
              });

              const citiesHtml = cities
                .map((city) => {
                  const areasInCity = [...cityMap[city]].sort((a, b) =>
                    (a.name || "").localeCompare(b.name || "", "ja")
                  );
                  return `
                    <h4 class="onsen-city-heading">📍${escapeHtml(city)}</h4>
                    ${areasInCity
                      .map(
                        (area) => `
                          <div class="onsen-area-box">
                            <div class="onsen-area-box-header">
                              <span class="onsen-area-name">♨️ ${escapeHtml(area.name)}</span>
                              <span class="onsen-area-count">${area.facilities.length}件表示</span>
                            </div>
                            <button type="button" class="onsen-area-toggle-btn">登録施設一覧はこちら</button>
                            <div class="onsen-area-facility-list hidden">
                              ${area.facilities.map((item) => renderAreaFacilityCard(item)).join("")}
                            </div>
                          </div>
                        `
                      )
                      .join("")}
                  `;
                })
                .join("");

              return `
                ${region ? `<h3 class="onsen-region-heading">${escapeHtml(region)}</h3>` : ""}
                ${citiesHtml}
              `;
            })
            .join("");

          return `
            <section class="onsen-pref-group">
              <h2 class="onsen-pref-heading">${escapeHtml(pref)}</h2>
              ${regionsHtml}
            </section>
          `;
        })
        .join("") || `<p class="detail-empty">該当する温泉地がありません。</p>`;

    content.querySelectorAll(".area-facility-detail-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        location.hash = `#detail-${btn.dataset.id}`;
      });
    });

    content.querySelectorAll(".onsen-area-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const list = btn.nextElementSibling;
        if (!list) return;
        const isHidden = list.classList.toggle("hidden");
        btn.textContent = isHidden ? "登録施設一覧はこちら" : "閉じる";
      });
    });
  }

  function openAreasFilterModal() {
    const prefectures = [...new Set(areasPageData.map((a) => a.prefecture || "").filter(Boolean))].sort();

    let modal = $("areasFilterModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "areasFilterModal";
      modal.className = "hidden";
      modal.setAttribute("aria-hidden", "true");
      document.body.appendChild(modal);
    }

    function citiesForSelectedPrefectures(selectedPrefs) {
      const source = selectedPrefs.length
        ? areasPageData.filter((a) => selectedPrefs.includes(a.prefecture || ""))
        : areasPageData;
      return [...new Set(source.map((a) => a.area || "").filter(Boolean))].sort();
    }

    function renderModalContent() {
      const cities = citiesForSelectedPrefectures(areasFilterState.prefectures);
      modal.innerHTML = `
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="areasFilterModalTitle">
          <button id="areasFilterClose" class="close" type="button" aria-label="閉じる">×</button>
          <div class="modal-head"><span class="modal-icon">🔎</span><div><h2 id="areasFilterModalTitle">温泉地を絞り込む</h2><p>都道府県・市区町村で絞り込みます。</p></div></div>

          <p class="field-title">都道府県</p>
          <div class="checks">
            ${prefectures
              .map(
                (p) =>
                  `<label><input type="checkbox" class="areas-filter-prefecture" value="${escapeHtml(p)}" ${areasFilterState.prefectures.includes(p) ? "checked" : ""}>${escapeHtml(p)}</label>`
              )
              .join("")}
          </div>

          <p class="field-title compact-top">市区町村</p>
          <div class="checks">
            ${
              cities.length
                ? cities
                    .map(
                      (c) =>
                        `<label><input type="checkbox" class="areas-filter-city" value="${escapeHtml(c)}" ${areasFilterState.cities.includes(c) ? "checked" : ""}>${escapeHtml(c)}</label>`
                    )
                    .join("")
                : `<p class="note-inline">都道府県を選ぶと市区町村が表示されます。</p>`
            }
          </div>

          <div class="form-actions">
            <button type="button" id="areasFilterReset" class="secondary">条件をリセット</button>
            <button type="button" id="areasFilterApply" class="primary submit">この条件で絞り込む</button>
          </div>
        </div>
      `;

      modal.querySelectorAll(".areas-filter-prefecture").forEach((el) => {
        el.addEventListener("change", () => {
          areasFilterState.prefectures = Array.from(modal.querySelectorAll(".areas-filter-prefecture:checked")).map(
            (e) => e.value
          );
          // 都道府県を変えたら、選択に合わない市区町村はクリア
          const validCities = citiesForSelectedPrefectures(areasFilterState.prefectures);
          areasFilterState.cities = areasFilterState.cities.filter((c) => validCities.includes(c));
          renderModalContent();
        });
      });

      $("areasFilterClose")?.addEventListener("click", closeAreasFilterModal);
      $("areasFilterReset")?.addEventListener("click", () => {
        areasFilterState = { prefectures: [], cities: [] };
        renderModalContent();
      });
      $("areasFilterApply")?.addEventListener("click", () => {
        areasFilterState.cities = Array.from(modal.querySelectorAll(".areas-filter-city:checked")).map((e) => e.value);
        closeAreasFilterModal();
        renderAreasPageContent();
      });
    }

    renderModalContent();
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }

  function closeAreasFilterModal() {
    const modal = $("areasFilterModal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }


  function showMyPageList(type) {
    const listView = $("listView");
    const myPageView = $("myPageListView");
    if (!myPageView) return;

    listView?.classList.add("hidden");
    $("mapSection")?.classList.add("hidden");
    $("siteHeader")?.classList.add("hidden");
    $("heroSection")?.classList.add("hidden");
    $("homeScrollToTopButton")?.classList.add("hidden");
    $("detailView")?.classList.add("hidden");
    $("areasView")?.classList.add("hidden");
    myPageView.classList.remove("hidden");
    window.scrollTo(0, 0);

    if (!currentUser) {
      myPageView.innerHTML = `
        <div class="detail-toolbar"><button type="button" id="myPageBack" class="detail-back">← 一覧に戻る</button></div>
        <div class="detail-empty">ログインすると見られます。</div>
      `;
      $("myPageBack")?.addEventListener("click", () => {
        location.hash = "";
      });
      return;
    }

    myPageView.dataset.type = type;

    const facilityById = {};
    (window.__onsenData || []).forEach((f) => {
      facilityById[f.id] = f;
    });

    const matchedFacilities = Object.keys(myFacilityStatusMap)
      .filter((id) => myFacilityStatusMap[id]?.[type])
      .map((id) => facilityById[id])
      .filter(Boolean);

    const title = type === "interested" ? "❤️ ここ気になる一覧" : "✅ 行ったことある一覧";

    myPageView.innerHTML = `
      <div class="detail-toolbar">
        <button type="button" id="myPageBack" class="detail-back">← 一覧に戻る</button>
      </div>
      <div class="areas-page-body">
        <h1>${title}</h1>
        ${
          matchedFacilities.length
            ? `<div class="onsen-area-facility-list">${matchedFacilities
                .map((item) => {
                  const removeLabel = type === "interested" ? "❤️ 気になるを取り消す" : "✅ 行ったことあるを取り消す";
                  const removeBtn = `<button type="button" class="my-page-remove-btn secondary" data-id="${escapeHtml(item.id ?? "")}">${removeLabel}</button>`;
                  return renderAreaFacilityCard(item, removeBtn);
                })
                .join("")}</div>`
            : `<p class="detail-empty">まだ登録されている施設がありません。</p>`
        }
      </div>
    `;

    $("myPageBack")?.addEventListener("click", () => {
      location.hash = "";
    });
    myPageView.querySelectorAll(".area-facility-detail-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        location.hash = `#detail-${btn.dataset.id}`;
      });
    });
    myPageView.querySelectorAll(".my-page-remove-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        toggleFacilityFlag(btn.dataset.id, type);
      });
    });
  }

  function renderMyPageIfActive() {
    const myPageView = $("myPageListView");
    if (!myPageView || myPageView.classList.contains("hidden")) return;
    if (myPageView.dataset.type) showMyPageList(myPageView.dataset.type);
  }

  function showList() {
    const listView = $("listView");
    const detailView = $("detailView");
    if (!listView || !detailView) return;

    detailView.classList.add("hidden");
    detailView.innerHTML = "";
    $("areasView")?.classList.add("hidden");
    $("myPageListView")?.classList.add("hidden");
    listView.classList.remove("hidden");
    $("mapSection")?.classList.remove("hidden");
    $("siteHeader")?.classList.remove("hidden");
    $("heroSection")?.classList.remove("hidden");
    if (leafletMap) {
      setTimeout(() => leafletMap.invalidateSize(), 0);
    }
  }

  function route() {
    const match = location.hash.match(/^#detail-(.+)$/);
    if (match) {
      showDetail(decodeURIComponent(match[1]));
    } else if (location.hash === "#areas") {
      showAreasPage();
    } else if (location.hash === "#mypage-interested") {
      showMyPageList("interested");
    } else if (location.hash === "#mypage-visited") {
      showMyPageList("visited");
    } else {
      showList();
    }
  }

  // ---------------------------------------------------------
  // 一覧データ取得
  // Supabaseが使える → Supabase
  // 使えない → LocalStorage
  // ---------------------------------------------------------

  function updateMigrateBanner() {
    const banner = $("migrateBanner");
    const text = $("migrateBannerText");
    if (!banner || !text) return;

    const localData = getLocalData();

    if (supabaseClient && localData.length > 0) {
      text.textContent = `この端末にだけ保存されている温泉が${localData.length}件あります。`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  async function migrateLocalDataToSupabase() {
    if (!supabaseClient) return;

    const localData = getLocalData();
    if (!localData.length) {
      updateMigrateBanner();
      return;
    }

    const button = $("migrateButton");
    if (button) {
      button.disabled = true;
      button.textContent = "移行しています…";
    }

    let successCount = 0;
    const failed = [];
    const errorMessages = new Set();

    for (const item of localData) {
      const payload = { ...item };
      delete payload.id; // ローカル用の仮IDはSupabase側では使わない

      try {
        await insertSupabaseData(payload);
        successCount += 1;
      } catch (error) {
        console.error("移行失敗:", item.name, error);
        failed.push(item);
        errorMessages.add(error.message || "不明なエラー");
      }
    }

    // 成功した分だけローカルストレージから削除し、失敗した分は端末に残しておく
    saveLocalData(failed);

    if (button) {
      button.disabled = false;
      button.textContent = "Supabaseに移行する";
    }

    if (failed.length) {
      alert(
        `${successCount}件を移行しました。\n` +
        `${failed.length}件は移行できませんでした（この端末には残っています）。\n\n` +
        `エラー内容：\n${[...errorMessages].join("\n")}`
      );
    } else {
      alert(`${successCount}件すべてSupabaseに移行しました。`);
    }

    // 表示をきちんと最新化するため、ページごと読み込み直す
    location.reload();
  }

  async function loadAll() {
    setStatus("温泉一覧を読み込んでいます…");
    updateMigrateBanner();

    try {
      if (supabaseClient) {
        const data = await loadSupabaseData();

        // Supabaseにデータがある場合はそれを表示。
        // 0件ならローカルデータも確認する。
        if (data.length > 0) {
          renderCards(data);
          return;
        }
      }

      const localData = getLocalData();
      renderCards(localData);

      if (supabaseClient) {
        setStatus(
          localData.length
            ? `Supabaseは0件のため、この端末の保存データ${localData.length}件を表示しています。`
            : "Supabaseに温泉がまだ登録されていません。",
          localData.length ? "ok" : ""
        );
      } else {
        setStatus(
          localData.length
            ? `この端末の保存データ${localData.length}件を表示しています。`
            : "Supabase未設定です。まず設定すると、みんなで共有できます。",
          localData.length ? "ok" : ""
        );
      }
    } catch (error) {
      const localData = getLocalData();
      renderCards(localData);

      setStatus(
        localData.length
          ? `Supabaseの読込に失敗したため、この端末の保存データ${localData.length}件を表示しています。`
          : `Supabaseの読込に失敗しました：${error.message || "不明なエラー"}`,
        "error"
      );
    }
  }

  // ---------------------------------------------------------
  // 保存
  // ---------------------------------------------------------

  async function submitModerationRequest(action, targetId, payload, name) {
    if (!supabaseClient) throw new Error("Supabaseが設定されていません。");

    const cleanPayload = payload ? filterKnownColumns(payload) : null;
    if (cleanPayload) delete cleanPayload.id;

    const { error } = await supabaseClient.from("moderation_queue").insert([
      {
        action,
        target_id: targetId || null,
        payload: cleanPayload,
        submitted_name: name || cleanPayload?.name || null,
        status: "pending"
      }
    ]);

    if (error) throw error;
  }

  async function saveOnsen(event) {
    event.preventDefault();

    if ($("genderCommonModeToggle")?.checked) mirrorAllGenderSections();

    let item;
    try {
      item = collectFormData();
    } catch (error) {
      console.error("フォーム内容の読み取りに失敗:", error);
      alert(
        "フォームの内容を読み取れませんでした。\n\n" +
        `詳細：${error.message || "不明なエラー"}\n\n` +
        "お手数ですが、この画面を閉じてもう一度お試しください。"
      );
      return;
    }

    if (!item.name) {
      alert("温泉名を入力してください。");
      $("name")?.focus();
      return;
    }

    if (!item.prefecture) {
      alert("都道府県を選択してください。");
      $("prefecture")?.focus();
      return;
    }

    if (!value("area")) {
      alert("市区町村・地域を選択してください。");
      $("area")?.focus();
      return;
    }

    if (value("area") === "その他" && !value("areaOther")) {
      alert("市区町村・地域（その他）を入力してください。");
      $("areaOther")?.focus();
      return;
    }

    const isEditing = Boolean(editingId);
    const targetId = editingId;
    const isLocalTarget = isEditing && String(targetId).startsWith("local-");

    const saveButton =
      document.querySelector('#form button[type="submit"]') ||
      document.querySelector('#form button:not(#cancel)');

    const originalButtonText = saveButton?.textContent;
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = "送信中…";
    }

    try {
      if (supabaseClient && !isLocalTarget) {
        await submitModerationRequest(
          isEditing ? "update" : "create",
          isEditing ? targetId : null,
          item,
          item.name
        );

        setStatus("管理者の確認待ちです。", "ok");
        clearDraft();
        editingId = null;
        resetForm();
        closeModal();

        if (isEditing && location.hash !== `#detail-${targetId}`) {
          location.hash = `#detail-${targetId}`;
        }

        alert(
          (isEditing
            ? `「${item.name}」の更新内容を送信しました。\n\n`
            : `「${item.name}」の登録内容を送信しました。\n\n`) +
          "内容を管理者が確認したあと、サイトに反映されます。しばらくお待ちください。"
        );
      } else {
        // Supabase未設定でも、内容を失わない
        const saved = isEditing
          ? updateLocalData(targetId, item)
          : addLocalData(item);

        clearDraft();
        editingId = null;
        resetForm();
        closeModal();
        await loadAll();

        if (isEditing) {
          await showDetail(targetId);
        }

        alert(
          (isEditing ? "温泉情報を更新しました。\n\n" : "温泉を登録しました。\n\n") +
          "現在はSupabaseのURL・anon keyが未設定なので、" +
          "この端末に保存しています。"
        );
        void saved;
      }
    } catch (error) {
      console.error(error);

      if (!isEditing) {
        // 新規登録時のみ、失敗しても入力内容をローカルへ退避
        try {
          addLocalData(item);
          await loadAll();
        } catch (_) {}
      }

      alert(
        (isEditing ? "更新内容を送信できませんでした。\n\n" : "登録内容を送信できませんでした。\n\n") +
        `詳細：${error.message || "送信に失敗しました。"}` +
        (isEditing ? "" : "\n\n入力内容はこの端末にも保存しました。")
      );

      setStatus(
        isEditing ? "Supabase更新失敗。" : "Supabase保存失敗。端末保存へ切り替えました。",
        "error"
      );
    } finally {
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = originalButtonText || saveButton.textContent;
      }
    }
  }

  // ---------------------------------------------------------
  // フォーム初期化
  // ---------------------------------------------------------

  function resetForm() {
    const form = $("form");
    if (!form) return;

    form.reset();

    if ($("genderCommonModeToggle")) $("genderCommonModeToggle").checked = true;
    applyGenderCommonModeUI();

    $("duplicateNameSuggestions")?.classList.add("hidden");
    renderMyRatingStars(0);
    $("normalHoursWrap")?.classList.remove("hidden");
    populateAreaOptions("", null);

    ["sun", "mon", "tue", "wed", "thu", "fri", "sat", "holiday"].forEach((code) => {
      $(`weekdayHoursWrap_${code}`)?.classList.add("hidden");
    });
    $("closedNthWeekdayWrap")?.classList.add("hidden");
    $("closedMonthlyDatesWrap")?.classList.add("hidden");

    // 動的なレンタル欄・料金欄は空に戻す
    const maleRentalRows = $("maleRentalRows");
    if (maleRentalRows) {
      maleRentalRows.innerHTML = "";
    }
    const femaleRentalRows = $("femaleRentalRows");
    if (femaleRentalRows) {
      femaleRentalRows.innerHTML = "";
    }
    const bathFeeRows = $("bathFeeRows");
    if (bathFeeRows) {
      bathFeeRows.innerHTML = "";
    }
    const otherFeeRows = $("otherFeeRows");
    if (otherFeeRows) {
      otherFeeRows.innerHTML = "";
    }
    ["ticketFeeRows", "disabilityFeeRows", "memberBenefitRows", "specialCouponRows", "restaurantAdditionalHoursRows", "shopAdditionalHoursRows", "massageAdditionalHoursRows", "convenienceStoreHoursRows", "overnightAdditionalHoursRows", "morningBathAdditionalHoursRows", "otherHoursAdditionalHoursRows"].forEach((id) => {
      const el = $(id);
      if (el) el.innerHTML = "";
    });

    // 「その他」の自由記述欄も隠しておく
    $("businessTypeOtherWrap")?.classList.add("hidden");
    $("usageOther")?.classList.add("hidden");
    $("purchaseMethodOther")?.classList.add("hidden");
    $("paymentOther")?.classList.add("hidden");
    $("maleSaunaStoveCountWrap")?.classList.add("hidden");
    $("femaleSaunaStoveCountWrap")?.classList.add("hidden");
    $("malePrivateBathCapacityWrap")?.classList.add("hidden");
    $("femalePrivateBathCapacityWrap")?.classList.add("hidden");
    $("maleSaunaStoveCountWrap")?.classList.add("hidden");
    $("femaleSaunaStoveCountWrap")?.classList.add("hidden");
    $("maleBathShapeOther")?.classList.add("hidden");
    $("femaleBathShapeOther")?.classList.add("hidden");
    $("maleBathFunctionOther")?.classList.add("hidden");
    $("femaleBathFunctionOther")?.classList.add("hidden");
    $("maleBathLocationOther")?.classList.add("hidden");
    $("femaleBathLocationOther")?.classList.add("hidden");
    $("maleShowerTypeOther")?.classList.add("hidden");
    $("femaleShowerTypeOther")?.classList.add("hidden");
    $("springTypeOther")?.classList.add("hidden");
    $("springColorOther")?.classList.add("hidden");
    $("springSmellOther")?.classList.add("hidden");
    $("springTextureOther")?.classList.add("hidden");
    $("springInfoSourceOther")?.classList.add("hidden");
    $("childInfoSourceOther")?.classList.add("hidden");
    $("maleSaunaFacilityLocationOther")?.classList.add("hidden");
    $("femaleSaunaFacilityLocationOther")?.classList.add("hidden");
    $("maleSaunaTypesOther")?.classList.add("hidden");
    $("femaleSaunaTypesOther")?.classList.add("hidden");
    $("maleSaunaStoveTypeOther")?.classList.add("hidden");
    $("femaleSaunaStoveTypeOther")?.classList.add("hidden");
    $("maleSaunaMatTypeOther")?.classList.add("hidden");
    $("femaleSaunaMatTypeOther")?.classList.add("hidden");
    $("maleSaunaMatPlacementOther")?.classList.add("hidden");
    $("femaleSaunaMatPlacementOther")?.classList.add("hidden");
    $("maleSaunaLoylyTypeOther")?.classList.add("hidden");
    $("femaleSaunaLoylyTypeOther")?.classList.add("hidden");
    $("maleSaunaDoorTypeOther")?.classList.add("hidden");
    $("femaleSaunaDoorTypeOther")?.classList.add("hidden");
    $("maleColdBathSourceOther")?.classList.add("hidden");
    $("femaleColdBathSourceOther")?.classList.add("hidden");
    $("maleColdBathCoolingOther")?.classList.add("hidden");
    $("femaleColdBathCoolingOther")?.classList.add("hidden");
    $("maleColdBathFlowOther")?.classList.add("hidden");
    $("femaleColdBathFlowOther")?.classList.add("hidden");
    $("maleOutdoorLocationOther")?.classList.add("hidden");
    $("femaleOutdoorLocationOther")?.classList.add("hidden");
    $("maleIndoorLocationOther")?.classList.add("hidden");
    $("femaleIndoorLocationOther")?.classList.add("hidden");
    $("maleLayingSpaceMaterialOther")?.classList.add("hidden");
    $("femaleLayingSpaceMaterialOther")?.classList.add("hidden");
    $("maleSceneryOther")?.classList.add("hidden");
    $("femaleSceneryOther")?.classList.add("hidden");
    $("maleLockerKeyTypeOther")?.classList.add("hidden");
    $("femaleLockerKeyTypeOther")?.classList.add("hidden");
    $("maleLockerWristbandTypeOther")?.classList.add("hidden");
    $("femaleLockerWristbandTypeOther")?.classList.add("hidden");
    $("maleLockerWristbandUseOther")?.classList.add("hidden");
    $("femaleLockerWristbandUseOther")?.classList.add("hidden");
    $("maleLockerSizeOther")?.classList.add("hidden");
    $("femaleLockerSizeOther")?.classList.add("hidden");
    $("maleShoeboxTypeOther")?.classList.add("hidden");
    $("femaleShoeboxTypeOther")?.classList.add("hidden");
    $("maleShoeboxKeyTypeOther")?.classList.add("hidden");
    $("femaleShoeboxKeyTypeOther")?.classList.add("hidden");
    $("toiletTypesOther")?.classList.add("hidden");
    $("restaurantTypesOther")?.classList.add("hidden");
    $("restaurantPaymentOther")?.classList.add("hidden");
    $("restaurantOtherInfoOther")?.classList.add("hidden");
    $("restaurantHoursWrap")?.classList.add("hidden");
    $("restSpaceTypeOther")?.classList.add("hidden");
    $("restSpaceFeeTypeOtherText")?.classList.add("hidden");
    $("restSpaceFeeAmountWrap")?.classList.add("hidden");
    $("restSpaceHoursWrap")?.classList.add("hidden");
    $("restSpacePerPersonWrap")?.classList.add("hidden");
    $("massageTypesOther")?.classList.add("hidden");
    $("massageHoursWrap")?.classList.add("hidden");
    $("coworkingFeaturesOther")?.classList.add("hidden");
    $("vendingMachineTypesOther")?.classList.add("hidden");
    $("vendingMachineLocationOther")?.classList.add("hidden");
    $("shopItemsOther")?.classList.add("hidden");
    $("shopPaymentOther")?.classList.add("hidden");
    $("parkingFeeAmountWrap")?.classList.add("hidden");
    $("parkingConditionsOther")?.classList.add("hidden");
    $("parkingTypesOther")?.classList.add("hidden");
    $("parkingAccessibleOther")?.classList.add("hidden");
    $("userInfoSourceOther")?.classList.add("hidden");
    $("shopHoursWrap")?.classList.add("hidden");
    $("convenienceStoreHoursWrap")?.classList.add("hidden");
    $("wifiFeeWrap")?.classList.add("hidden");
    $("chargingFeeWrap")?.classList.add("hidden");
    const massageFeeRows = $("massageFeeRows");
    if (massageFeeRows) massageFeeRows.innerHTML = "";
    $("maleSaunaHoursWrap")?.classList.add("hidden");
    $("femaleSaunaHoursWrap")?.classList.add("hidden");
  }

  // ---------------------------------------------------------
  // イベント
  // ---------------------------------------------------------

  function setupEvents() {
    $("form")?.addEventListener("submit", saveOnsen);

    // 施設名の重複チェック（新規追加時のみ）
    let duplicateNameCheckTimer = null;
    $("name")?.addEventListener("input", (event) => {
      clearTimeout(duplicateNameCheckTimer);
      if (editingId) {
        $("duplicateNameSuggestions")?.classList.add("hidden");
        return;
      }
      const query = event.target.value;
      duplicateNameCheckTimer = setTimeout(() => {
        renderDuplicateNameSuggestions(findSimilarNamedOnsens(query));
      }, 400);
    });

    // 入力途中の内容を自動で下書き保存しておく（リロード・誤操作対策）
    // ※項目数が非常に多いフォームのため、保存頻度を抑えて負荷を軽くする
    let draftSaveTimer = null;
    $("form")?.addEventListener("input", () => {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = setTimeout(() => {
        saveDraft(editingId ? "edit" : "add", editingId);
      }, 1500);
    });
    $("form")?.addEventListener("change", () => {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = setTimeout(() => {
        saveDraft(editingId ? "edit" : "add", editingId);
      }, 1500);
    });

    $("search")?.addEventListener("input", () => {
      saveAppState();
      // 検索時は現在表示できるデータを再取得
      if (window.__onsenData) {
        renderCards(window.__onsenData);
        updateMap(getFilteredSortedList(window.__onsenData));
      } else {
        renderCards(getLocalData());
        updateMap(getFilteredSortedList(getLocalData()));
      }
    });

    $("sortModeSelect")?.addEventListener("change", () => {
      saveAppState();
      if (window.__onsenData) {
        renderCards(window.__onsenData);
        updateMap(getFilteredSortedList(window.__onsenData));
      } else {
        renderCards(getLocalData());
        updateMap(getFilteredSortedList(getLocalData()));
      }
    });

    $("add")?.addEventListener("click", () => {
      const modal = $("modal");
      if (!modal) return;

      modal.classList.remove("hidden");
      modal.setAttribute("aria-hidden", "false");
      document.body.classList.add("modal-open");

      const draft = getDraft();
      let resumed = false;

      if (draft && draft.mode === "add") {
        const savedAtText = draft.savedAt
          ? new Date(draft.savedAt).toLocaleString("ja-JP")
          : "";
        const ok = confirm(
          `入力途中の内容が残っています（${savedAtText}）。\n続きから編集を再開しますか？\n\n` +
          "「キャンセル」を押すと、この下書きは削除されます。"
        );
        if (ok) {
          resetForm();
          populateForm(draft.data);
          switchFormTab(draft.activeTab || "basic");
          resumed = true;
        } else {
          clearDraft();
        }
      }

      if (!resumed) {
        switchFormTab("basic");

        // レンタル品欄が空なら、まず1行用意しておく（フォーカスは奪わない）
        ["maleRentalRows", "femaleRentalRows"].forEach((containerId) => {
          const rows = $(containerId);
          if (rows && !rows.children.length) {
            addRentalRow(containerId, "", "", { focus: false });
          }
        });

        // 入浴料・その他料金区分も、空ならデフォルトの区分名で行を用意しておく
        const bathFeeRows = $("bathFeeRows");
        if (bathFeeRows && !bathFeeRows.children.length) {
          DEFAULT_BATH_FEE_CATEGORIES.forEach((category) =>
            addFeeRow("bathFeeRows", category, "", { focus: false })
          );
        }

        const otherFeeRows = $("otherFeeRows");
        if (otherFeeRows && !otherFeeRows.children.length) {
          DEFAULT_OTHER_FEE_CATEGORIES.forEach((category) =>
            addFeeRow("otherFeeRows", category, "", { focus: false })
          );
        }

        const massageFeeRows = $("massageFeeRows");
        if (massageFeeRows && !massageFeeRows.children.length) {
          addFeeRow3("massageFeeRows", "", "", "", { focus: false });
        }
      }

      // モーダルを開いたら温泉名欄にフォーカス
      setTimeout(() => $("name")?.focus(), 0);
    });

    $("maleAddRental")?.addEventListener("click", () => addRentalRow("maleRentalRows"));
    $("femaleAddRental")?.addEventListener("click", () => addRentalRow("femaleRentalRows"));
    $("addBathFee")?.addEventListener("click", () => addFeeRow("bathFeeRows"));
    $("addRestaurantAdditionalHours")?.addEventListener("click", () =>
      addHoursRangeRow("restaurantAdditionalHoursRows")
    );
    $("restaurantAdditionalHoursRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;
      button.closest(".hours-range-row")?.remove();
    });
    $("addOvernightAdditionalHours")?.addEventListener("click", () =>
      addHoursRangeRow("overnightAdditionalHoursRows", "", "", { withLastEntry: true, withDays: true })
    );
    $("overnightAdditionalHoursRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;
      button.closest(".hours-range-row")?.remove();
    });
    $("addMorningBathAdditionalHours")?.addEventListener("click", () =>
      addHoursRangeRow("morningBathAdditionalHoursRows", "", "", { withLastEntry: true, withDays: true })
    );
    $("morningBathAdditionalHoursRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;
      button.closest(".hours-range-row")?.remove();
    });
    $("addOtherHoursAdditionalHours")?.addEventListener("click", () =>
      addHoursRangeRow("otherHoursAdditionalHoursRows", "", "", { withLastEntry: true, withDays: true })
    );
    $("otherHoursAdditionalHoursRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;
      button.closest(".hours-range-row")?.remove();
    });
    $("addShopAdditionalHours")?.addEventListener("click", () => addHoursRangeRow("shopAdditionalHoursRows"));
    $("shopAdditionalHoursRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;
      button.closest(".hours-range-row")?.remove();
    });
    $("addConvenienceStoreHours")?.addEventListener("click", () => addHoursRangeRow("convenienceStoreHoursRows"));
    $("convenienceStoreHoursRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;
      button.closest(".hours-range-row")?.remove();
    });
    $("addMassageAdditionalHours")?.addEventListener("click", () =>
      addHoursRangeRow("massageAdditionalHoursRows")
    );
    $("massageAdditionalHoursRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;
      button.closest(".hours-range-row")?.remove();
    });
    $("addTicketFee")?.addEventListener("click", () => addTicketFeeRow("ticketFeeRows"));
    $("ticketFeeRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;
      button.closest(".rental-row-3")?.remove();
    });
    $("addDisabilityFee")?.addEventListener("click", () => addFeeRow("disabilityFeeRows"));
    $("disabilityFeeRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;
      button.closest(".rental-row")?.remove();
    });
    $("addMemberBenefit")?.addEventListener("click", () => addBenefitRow("memberBenefitRows"));
    $("memberBenefitRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;
      button.closest(".rental-row")?.remove();
    });
    $("addSpecialCoupon")?.addEventListener("click", () => addBenefitRow("specialCouponRows"));
    $("specialCouponRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;
      button.closest(".rental-row")?.remove();
    });
    $("addOtherFee")?.addEventListener("click", () => addFeeRow("otherFeeRows"));

    // 施設業態で「その他」を選んだ時だけ自由記述欄を表示
    $("businessType")?.addEventListener("change", (event) => {
      const wrap = $("businessTypeOtherWrap");
      if (!wrap) return;
      wrap.classList.toggle("hidden", event.target.value !== "その他");
    });

    // 利用条件の「その他」にチェックが入った時だけ自由記述欄を表示
    $("usageOtherCheck")?.addEventListener("change", (event) => {
      const other = $("usageOther");
      if (!other) return;
      other.classList.toggle("hidden", !event.target.checked);
    });

    // 購入方法の「その他」にチェックが入った時だけ自由記述欄を表示
    $("purchaseMethodOtherCheck")?.addEventListener("change", (event) => {
      $("purchaseMethodOther")?.classList.toggle("hidden", !event.target.checked);
    });

    ["springType", "sourceType"].forEach((groupName) => {
      document.querySelectorAll(`input[name="${groupName}"]`).forEach((radio) => {
        radio.addEventListener("change", () => {
          $(`${groupName}Other`)?.classList.toggle("hidden", radioValue(groupName) !== "その他");
        });
      });
    });

    ["male", "female"].forEach((gender) => {
      [
        ["SaunaFacilityLocation", "SaunaFacilityLocationOther"],
        ["SaunaStoveType", "SaunaStoveTypeOther"],
        ["SaunaDoorType", "SaunaDoorTypeOther"]
      ].forEach(([groupSuffix, wrapSuffix]) => {
        const groupName = `${gender}${groupSuffix}`;
        const wrapId = `${gender}${wrapSuffix}`;
        document.querySelectorAll(`input[name="${groupName}"]`).forEach((radio) => {
          radio.addEventListener("change", () => {
            const wrap = $(wrapId);
            if (!wrap) return;
            wrap.classList.toggle("hidden", radioValue(groupName) !== "その他");
          });
        });
      });
    });

    // 決済方法の「その他」にチェックが入った時だけ自由記述欄を表示
    $("paymentOtherCheck")?.addEventListener("change", (event) => {
      const other = $("paymentOther");
      if (!other) return;
      other.classList.toggle("hidden", !event.target.checked);
    });

    // 浴場・浴槽関連の「その他」チェックボックスも同様にトグル
    // サウナの利用時間：「利用時間あり」を選んだ時だけ時間欄を表示
    ["male", "female"].forEach((gender) => {
      document.querySelectorAll(`input[name="${gender}SaunaHoursType"]`).forEach((radio) => {
        radio.addEventListener("change", () => {
          const wrap = $(`${gender}SaunaHoursWrap`);
          if (!wrap) return;
          wrap.classList.toggle("hidden", radioValue(`${gender}SaunaHoursType`) !== "利用時間あり");
        });
      });
    });

    // 家族風呂・貸切風呂の定員：「人数を指定」を選んだ時だけ人数欄を表示
    ["male", "female"].forEach((gender) => {
      document.querySelectorAll(`input[name="${gender}PrivateBathCapacityStatus"]`).forEach((radio) => {
        radio.addEventListener("change", () => {
          const wrap = $(`${gender}PrivateBathCapacityWrap`);
          if (!wrap) return;
          wrap.classList.toggle("hidden", radioValue(`${gender}PrivateBathCapacityStatus`) !== "人数あり");
        });
      });
    });

    // ストーブの台数：「台数を指定」を選んだ時だけ台数欄を表示
    ["male", "female"].forEach((gender) => {
      document.querySelectorAll(`input[name="${gender}SaunaStoveCountStatus"]`).forEach((radio) => {
        radio.addEventListener("change", () => {
          const wrap = $(`${gender}SaunaStoveCountWrap`);
          if (!wrap) return;
          wrap.classList.toggle("hidden", radioValue(`${gender}SaunaStoveCountStatus`) !== "台数あり");
        });
      });
    });

    // お食事処・休憩スペース等施設：条件付き表示のトグル一覧
    [
      ["restaurantHoursType", "営業時間あり", "restaurantHoursWrap"],
      ["restSpaceHoursType", "利用時間あり", "restSpaceHoursWrap"],
      ["restSpacePerPersonType", "時間指定", "restSpacePerPersonWrap"],
      ["massageHoursType", "営業時間あり", "massageHoursWrap"],
      ["shopHoursType", "利用時間あり", "shopHoursWrap"],
      ["convenienceStoreHoursType", "営業時間あり", "convenienceStoreHoursWrap"],
      ["wifiFacility", "有料", "wifiFeeWrap"],
      ["chargingSpot", "有料", "chargingFeeWrap"]
    ].forEach(([name, triggerValue, wrapId]) => {
      document.querySelectorAll(`input[name="${name}"]`).forEach((radio) => {
        radio.addEventListener("change", () => {
          const wrap = $(wrapId);
          if (!wrap) return;
          wrap.classList.toggle("hidden", radioValue(name) !== triggerValue);
        });
      });
    });

    // 休憩スペースの利用料金：「その他」を選んだ時だけ自由記述欄を表示
    document.querySelectorAll('input[name="restSpaceFeeType"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        const other = $("restSpaceFeeTypeOtherText");
        const feeWrap = $("restSpaceFeeAmountWrap");
        if (other) other.classList.toggle("hidden", radioValue("restSpaceFeeType") !== "その他");
        if (feeWrap) feeWrap.classList.toggle("hidden", radioValue("restSpaceFeeType") !== "別料金");
      });
    });

    $("addMassageFee")?.addEventListener("click", () => addFeeRow3("massageFeeRows"));
    $("massageFeeRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;
      button.closest(".rental-row")?.remove();
    });

    // 駐車料金：「有料」を選んだ時だけ料金欄を表示
    document.querySelectorAll('input[name="parkingFeeType"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        const wrap = $("parkingFeeAmountWrap");
        if (!wrap) return;
        wrap.classList.toggle("hidden", radioValue("parkingFeeType") !== "有料");
      });
    });

    // 最終訪問日・最終情報確認日：今日／昨日／一昨日ボタン
    document.querySelectorAll("[data-quickdate-prefix]").forEach((button) => {
      button.addEventListener("click", () => {
        const prefix = button.dataset.quickdatePrefix;
        const offset = Number(button.dataset.quickdateOffset || 0);
        const d = new Date();
        d.setDate(d.getDate() + offset);
        if ($(`${prefix}Year`)) $(`${prefix}Year`).value = String(d.getFullYear());
        if ($(`${prefix}Month`)) $(`${prefix}Month`).value = String(d.getMonth() + 1);
        if ($(`${prefix}Day`)) $(`${prefix}Day`).value = String(d.getDate());
      });
    });

    [
      ["maleBathShapeOtherCheck", "maleBathShapeOther"],
      ["femaleBathShapeOtherCheck", "femaleBathShapeOther"],
      ["maleBathFunctionOtherCheck", "maleBathFunctionOther"],
      ["femaleBathFunctionOtherCheck", "femaleBathFunctionOther"],
      ["maleBathLocationOtherCheck", "maleBathLocationOther"],
      ["femaleBathLocationOtherCheck", "femaleBathLocationOther"],
      ["maleShowerTypeOtherCheck", "maleShowerTypeOther"],
      ["femaleShowerTypeOtherCheck", "femaleShowerTypeOther"],
      ["springTypeOtherCheck", "springTypeOther"],
      ["springColorOtherCheck", "springColorOther"],
      ["springSmellOtherCheck", "springSmellOther"],
      ["springTextureOtherCheck", "springTextureOther"],
      ["springInfoSourceOtherCheck", "springInfoSourceOther"],
      ["childInfoSourceOtherCheck", "childInfoSourceOther"],
      ["maleSaunaTypesOtherCheck", "maleSaunaTypesOther"],
      ["femaleSaunaTypesOtherCheck", "femaleSaunaTypesOther"],
      ["maleSaunaMatTypeOtherCheck", "maleSaunaMatTypeOther"],
      ["femaleSaunaMatTypeOtherCheck", "femaleSaunaMatTypeOther"],
      ["maleSaunaMatPlacementOtherCheck", "maleSaunaMatPlacementOther"],
      ["femaleSaunaMatPlacementOtherCheck", "femaleSaunaMatPlacementOther"],
      ["maleSaunaLoylyTypeOtherCheck", "maleSaunaLoylyTypeOther"],
      ["femaleSaunaLoylyTypeOtherCheck", "femaleSaunaLoylyTypeOther"],
      ["maleColdBathSourceOtherCheck", "maleColdBathSourceOther"],
      ["femaleColdBathSourceOtherCheck", "femaleColdBathSourceOther"],
      ["maleColdBathCoolingOtherCheck", "maleColdBathCoolingOther"],
      ["femaleColdBathCoolingOtherCheck", "femaleColdBathCoolingOther"],
      ["maleColdBathFlowOtherCheck", "maleColdBathFlowOther"],
      ["femaleColdBathFlowOtherCheck", "femaleColdBathFlowOther"],
      ["maleOutdoorLocationOtherCheck", "maleOutdoorLocationOther"],
      ["femaleOutdoorLocationOtherCheck", "femaleOutdoorLocationOther"],
      ["maleIndoorLocationOtherCheck", "maleIndoorLocationOther"],
      ["femaleIndoorLocationOtherCheck", "femaleIndoorLocationOther"],
      ["maleLayingSpaceMaterialOtherCheck", "maleLayingSpaceMaterialOther"],
      ["femaleLayingSpaceMaterialOtherCheck", "femaleLayingSpaceMaterialOther"],
      ["maleSceneryOtherCheck", "maleSceneryOther"],
      ["femaleSceneryOtherCheck", "femaleSceneryOther"],
      ["maleLockerKeyTypeOtherCheck", "maleLockerKeyTypeOther"],
      ["femaleLockerKeyTypeOtherCheck", "femaleLockerKeyTypeOther"],
      ["maleLockerWristbandTypeOtherCheck", "maleLockerWristbandTypeOther"],
      ["femaleLockerWristbandTypeOtherCheck", "femaleLockerWristbandTypeOther"],
      ["maleLockerWristbandUseOtherCheck", "maleLockerWristbandUseOther"],
      ["femaleLockerWristbandUseOtherCheck", "femaleLockerWristbandUseOther"],
      ["maleLockerSizeOtherCheck", "maleLockerSizeOther"],
      ["femaleLockerSizeOtherCheck", "femaleLockerSizeOther"],
      ["maleShoeboxTypeOtherCheck", "maleShoeboxTypeOther"],
      ["femaleShoeboxTypeOtherCheck", "femaleShoeboxTypeOther"],
      ["maleShoeboxKeyTypeOtherCheck", "maleShoeboxKeyTypeOther"],
      ["femaleShoeboxKeyTypeOtherCheck", "femaleShoeboxKeyTypeOther"],
      ["toiletTypesOtherCheck", "toiletTypesOther"],
      ["restaurantTypesOtherCheck", "restaurantTypesOther"],
      ["restaurantPaymentOtherCheck", "restaurantPaymentOther"],
      ["restaurantOtherInfoOtherCheck", "restaurantOtherInfoOther"],
      ["restSpaceTypeOtherCheck", "restSpaceTypeOther"],
      ["massageTypesOtherCheck", "massageTypesOther"],
      ["coworkingFeaturesOtherCheck", "coworkingFeaturesOther"],
      ["vendingMachineTypesOtherCheck", "vendingMachineTypesOther"],
      ["vendingMachineLocationOtherCheck", "vendingMachineLocationOther"],
      ["shopItemsOtherCheck", "shopItemsOther"],
      ["shopPaymentOtherCheck", "shopPaymentOther"],
      ["parkingConditionsOtherCheck", "parkingConditionsOther"],
      ["parkingTypesOtherCheck", "parkingTypesOther"],
      ["parkingAccessibleOtherCheck", "parkingAccessibleOther"],
      ["userInfoSourceOtherCheck", "userInfoSourceOther"]
    ].forEach(([checkId, inputId]) => {
      $(checkId)?.addEventListener("change", (event) => {
        const other = $(inputId);
        if (!other) return;
        other.classList.toggle("hidden", !event.target.checked);
      });
    });

    $("maleRentalRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;

      button.closest(".rental-row")?.remove();
    });

    $("femaleRentalRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;

      button.closest(".rental-row")?.remove();
    });

    $("bathFeeRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;

      button.closest(".rental-row")?.remove();
    });

    $("otherFeeRows")?.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-rental");
      if (!button) return;

      button.closest(".rental-row")?.remove();
    });

    document.querySelectorAll("#formTabBar .tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchFormTab(btn.dataset.tabTarget));
    });

    $("migrateButton")?.addEventListener("click", () => migrateLocalDataToSupabase());

    // ---------------------------------------------------------
    // ログイン・アカウント機能
    // ---------------------------------------------------------

    $("openAuthButton")?.addEventListener("click", openAuthModal);
    $("userInfoLoginPrompt")?.addEventListener("click", openAuthModal);
    $("authClose")?.addEventListener("click", closeAuthModal);
    $("authCancel")?.addEventListener("click", closeAuthModal);

    $("authToggleMode")?.addEventListener("click", () => {
      setAuthMode(authMode === "login" ? "signup" : "login");
    });

    $("authSubmit")?.addEventListener("click", async () => {
      const email = value("authEmail").trim();
      const password = value("authPassword");
      const errorEl = $("authError");
      errorEl?.classList.add("hidden");

      if (!email || !password) {
        if (errorEl) {
          errorEl.textContent = "メールアドレスとパスワードを入力してください。";
          errorEl.classList.remove("hidden");
        }
        return;
      }

      try {
        if (authMode === "signup") {
          const { error } = await supabaseClient.auth.signUp({ email, password });
          if (error) throw error;
          alert("登録できました。確認メールが届いていればご確認ください。");
        } else {
          const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
          if (error) throw error;
        }
        await refreshAuthState();
        closeAuthModal();
      } catch (error) {
        if (errorEl) {
          errorEl.textContent = error.message || "処理できませんでした。";
          errorEl.classList.remove("hidden");
        }
      }
    });

    $("authGoogleButton")?.addEventListener("click", async () => {
      try {
        const { error } = await supabaseClient.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: location.href.split("#")[0] }
        });
        if (error) throw error;
      } catch (error) {
        alert(`Googleログインを開始できませんでした：${error.message || "不明なエラー"}`);
      }
    });

    $("authLogoutButton")?.addEventListener("click", async () => {
      await supabaseClient.auth.signOut();
      await refreshAuthState();
      closeAuthModal();
    });

    $("authSaveProfile")?.addEventListener("click", async () => {
      try {
        const { error } = await supabaseClient.auth.updateUser({
          data: { display_name: value("authDisplayName").trim() }
        });
        if (error) throw error;
        await refreshAuthState();
        alert("保存しました。");
      } catch (error) {
        alert(`保存できませんでした：${error.message || "不明なエラー"}`);
      }
    });

    $("goToInterestedList")?.addEventListener("click", () => {
      closeAuthModal();
      location.hash = "#mypage-interested";
    });
    $("goToVisitedList")?.addEventListener("click", () => {
      closeAuthModal();
      location.hash = "#mypage-visited";
    });

    if (supabaseClient) refreshAuthState();

    // ---------------------------------------------------------
    // ⭐️ 自分の評価（星レーティング）
    // ---------------------------------------------------------

    document.querySelectorAll(".rating-star").forEach((star) => {
      star.addEventListener("click", () => {
        const targetOnsenId = editingId;
        if (!targetOnsenId) {
          alert("この施設を登録したあとに評価できます。");
          return;
        }
        if (!currentUser) {
          openAuthModal();
          return;
        }
        submitMyRating(targetOnsenId, Number(star.dataset.star));
      });
    });

    $("saveMyImpressionButton")?.addEventListener("click", () => {
      submitMyImpression(editingId, value("myImpression").trim());
    });

    if (supabaseClient) loadRatingSummary();
    if (supabaseClient) loadOnsenAreasForMap();

    // 絞り込み検索モーダル
    // ご意見・アイデアフォーム
    $("is24Hours")?.addEventListener("change", (event) => {
      $("normalHoursWrap")?.classList.toggle("hidden", event.target.checked);
    });

    const dialogEl = document.querySelector("#modal .dialog");
    dialogEl?.addEventListener("scroll", () => {
      $("scrollToTopButton")?.classList.toggle("hidden", dialogEl.scrollTop < 400);
    });
    $("scrollToTopButton")?.addEventListener("click", () => {
      dialogEl?.scrollTo({ top: 0, behavior: "smooth" });
    });

    $("prefecture")?.addEventListener("change", (event) => {
      populateAreaOptions(event.target.value, null);
    });
    $("area")?.addEventListener("change", (event) => {
      $("areaOtherWrap")?.classList.toggle("hidden", event.target.value !== "その他");
    });

    $("openFeedbackButton")?.addEventListener("click", () => {
      $("feedbackModal")?.classList.remove("hidden");
      $("feedbackModal")?.setAttribute("aria-hidden", "false");
      document.body.classList.add("modal-open");
    });
    function closeFeedbackModal() {
      $("feedbackModal")?.classList.add("hidden");
      $("feedbackModal")?.setAttribute("aria-hidden", "true");
      document.body.classList.remove("modal-open");
      if ($("feedbackMessage")) $("feedbackMessage").value = "";
    }
    $("feedbackClose")?.addEventListener("click", closeFeedbackModal);
    $("feedbackCancel")?.addEventListener("click", closeFeedbackModal);
    let feedbackModalPressStartedOnBackdrop = false;
    $("feedbackModal")?.addEventListener("pointerdown", (event) => {
      feedbackModalPressStartedOnBackdrop = event.target === $("feedbackModal");
    });
    $("feedbackModal")?.addEventListener("click", (event) => {
      if (event.target === $("feedbackModal") && feedbackModalPressStartedOnBackdrop) {
        closeFeedbackModal();
      }
      feedbackModalPressStartedOnBackdrop = false;
    });
    $("feedbackSubmit")?.addEventListener("click", async () => {
      const message = value("feedbackMessage").trim();
      if (!message) {
        alert("内容を入力してください。");
        return;
      }
      if (!supabaseClient) {
        alert("現在この機能は利用できません（Supabase未設定）。");
        return;
      }
      const btn = $("feedbackSubmit");
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "送信中…";
      try {
        const { error } = await supabaseClient.from("feedback").insert([{ message }]);
        if (error) throw error;
        closeFeedbackModal();
        alert("ご意見を送信しました。ありがとうございます！");
      } catch (error) {
        alert(`送信できませんでした。\n\n詳細：${error.message || "不明なエラー"}`);
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });

    $("openAreasButton")?.addEventListener("click", () => {
      location.hash = "#areas";
    });

    $("openFilterButton")?.addEventListener("click", () => {
      $("filterModal")?.classList.remove("hidden");
      $("filterModal")?.setAttribute("aria-hidden", "false");
      document.body.classList.add("modal-open");
    });

    function closeFilterModal() {
      $("filterModal")?.classList.add("hidden");
      $("filterModal")?.setAttribute("aria-hidden", "true");
      document.body.classList.remove("modal-open");
    }

    $("filterClose")?.addEventListener("click", closeFilterModal);

    let filterModalPressStartedOnBackdrop = false;
    $("filterModal")?.addEventListener("pointerdown", (event) => {
      filterModalPressStartedOnBackdrop = event.target === $("filterModal");
    });
    $("filterModal")?.addEventListener("click", (event) => {
      if (event.target === $("filterModal") && filterModalPressStartedOnBackdrop) {
        closeFilterModal();
      }
      filterModalPressStartedOnBackdrop = false;
    });

    // 都道府県を選ぶと、その都道府県の市区町村チェックボックスを表示
    document.querySelectorAll(".filter-prefecture").forEach((el) => {
      el.addEventListener("change", buildCityFilterGroups);
    });

    // 施設分類「すべて」の一括チェック
    $("filterCategoryAll")?.addEventListener("change", (event) => {
      document.querySelectorAll(".filter-category").forEach((el) => {
        el.checked = event.target.checked;
      });
    });
    document.querySelectorAll(".filter-category").forEach((el) => {
      el.addEventListener("change", () => {
        const all = document.querySelectorAll(".filter-category");
        const checked = document.querySelectorAll(".filter-category:checked");
        if ($("filterCategoryAll")) {
          $("filterCategoryAll").checked = all.length === checked.length;
        }
      });
    });

    // 駐車場検索「すべて」の一括チェック
    $("filterParkingAll")?.addEventListener("change", (event) => {
      document.querySelectorAll(".filter-parking").forEach((el) => {
        el.checked = event.target.checked;
      });
    });
    document.querySelectorAll(".filter-parking").forEach((el) => {
      el.addEventListener("change", () => {
        const all = document.querySelectorAll(".filter-parking");
        const checked = document.querySelectorAll(".filter-parking:checked");
        if ($("filterParkingAll")) {
          $("filterParkingAll").checked = all.length === checked.length;
        }
      });
    });

    // 料金プリセットを選ぶとスライダーにも反映
    document.querySelectorAll('input[name="filterPrice"]').forEach((el) => {
      el.addEventListener("change", () => {
        filterPriceSliderTouched = false;
        const val = el.value;
        const num = Number(val.replace(/[^0-9]/g, ""));
        if ($("filterPriceSlider") && !Number.isNaN(num) && num > 0) {
          $("filterPriceSlider").value = Math.min(num, 2000);
          $("filterPriceSliderValue").textContent = Math.min(num, 2000).toLocaleString();
        } else if ($("filterPriceSlider")) {
          $("filterPriceSlider").value = 2000;
          $("filterPriceSliderValue").textContent = "2,000";
        }
      });
    });

    // スライダーを直接動かした場合は、そちらを優先する
    $("filterPriceSlider")?.addEventListener("input", (event) => {
      filterPriceSliderTouched = true;
      document.querySelectorAll('input[name="filterPrice"]').forEach((el) => {
        el.checked = false;
      });
      $("filterPriceSliderValue").textContent = Number(event.target.value).toLocaleString();
    });

    $("filterReset")?.addEventListener("click", () => {
      resetFilterForm();
      filterPriceSliderTouched = false;
      window.__activeFacetFilters = null;
      saveAppState();
      renderCardsWithData(window.__onsenData);
    });

    $("filterApply")?.addEventListener("click", () => {
      window.__activeFacetFilters = collectFacetFilters();
      saveAppState();
      closeFilterModal();
      renderCardsWithData(window.__onsenData);
    });

    ["sun", "mon", "tue", "wed", "thu", "fri", "sat", "holiday"].forEach((code) => {
      $(`weekdayHoursEnabled_${code}`)?.addEventListener("change", (event) => {
        $(`weekdayHoursWrap_${code}`)?.classList.toggle("hidden", !event.target.checked);
      });
    });

    $("closedNthWeekdayEnabled")?.addEventListener("change", (event) => {
      $("closedNthWeekdayWrap")?.classList.toggle("hidden", !event.target.checked);
    });
    $("closedMonthlyDatesEnabled")?.addEventListener("change", (event) => {
      $("closedMonthlyDatesWrap")?.classList.toggle("hidden", !event.target.checked);
    });

    window.addEventListener("scroll", () => {
      $("homeScrollToTopButton")?.classList.toggle("hidden", window.scrollY < 400);
    });
    $("homeScrollToTopButton")?.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    $("showMoreButton")?.addEventListener("click", () => {
      listDisplayLimit += LIST_PAGE_SIZE;
      renderCards(lastRenderCardsList || window.__onsenData || []);
    });

    $("mapStyleToggleButton")?.addEventListener("click", () => {
      applyMapStyle(currentMapStyle === "aerial" ? "osm" : "aerial");
    });

    $("showCurrentLocationButton")?.addEventListener("click", () => {
      highlightedFacilityId = null;
      requestUserLocation({ recenter: true });
    });

    $("extractLatLngButton")?.addEventListener("click", () => {
      const url = value("googleMapsUrl");

      if (!url) {
        alert("先にGoogleマップのリンクを入力してください。");
        return;
      }

      const coords = extractLatLngFromGoogleMapsUrl(url);

      if (!coords) {
        alert(
          "このリンクからは緯度経度を読み取れませんでした。\n\n" +
          "短縮リンク（maps.app.goo.gl等）の場合は、一度ブラウザでリンクを開いて、" +
          "展開された長いURLを貼り直してから、もう一度お試しください。"
        );
        return;
      }

      setValue("lat", coords.lat);
      setValue("lng", coords.lng);
      alert(`緯度・経度を入力しました。\n緯度：${coords.lat}\n経度：${coords.lng}`);
    });

    $("close")?.addEventListener("click", closeModal);
    $("cancel")?.addEventListener("click", closeModal);

    // 背景（バックドロップ）を押し始めて、そのまま押し終えた時だけ閉じる。
    // ダイアログ内をスクロールした際に指が背景側で離れて誤って閉じてしまう
    // モバイルでの不具合を防ぐため、押し始めた場所も背景かどうかを確認する。
    let modalPressStartedOnBackdrop = false;

    $("modal")?.addEventListener("pointerdown", (event) => {
      modalPressStartedOnBackdrop = event.target === $("modal");
    });

    $("modal")?.addEventListener("click", (event) => {
      if (event.target === $("modal") && modalPressStartedOnBackdrop) {
        closeModal();
      }
      modalPressStartedOnBackdrop = false;
    });

    // カードクリック・Enterキーで詳細画面へ
    $("cards")?.addEventListener("click", (event) => {
      if (event.target.closest("a")) return; // 外部リンクはそのまま開く
      if (event.target.closest(".show-on-map")) return; // マップ確認ボタンは別処理
      if (event.target.closest("#clearHighlightButton")) return; // 解除ボタンは別処理
      if (event.target.closest(".toggle-interested")) return; // 気になるボタンは別処理
      if (event.target.closest(".toggle-visited")) return; // 行った済みボタンは別処理

      const card = event.target.closest(".card");
      if (!card) return;

      const id = card.getAttribute("data-id");
      if (id) location.hash = `detail-${encodeURIComponent(id)}`;
    });

    $("cards")?.addEventListener("click", (event) => {
      const button = event.target.closest(".show-on-map");
      if (!button) return;
      showFacilityOnMap(button.dataset.id);
    });

    $("cards")?.addEventListener("click", (event) => {
      if (!event.target.closest("#clearHighlightButton")) return;
      highlightedFacilityId = null;
      renderCardsWithData(window.__onsenData || getLocalData());
    });

    $("cards")?.addEventListener("click", (event) => {
      const button = event.target.closest(".toggle-interested");
      if (!button) return;
      toggleFacilityFlag(button.dataset.id, "interested");
    });

    $("cards")?.addEventListener("click", (event) => {
      const button = event.target.closest(".toggle-visited");
      if (!button) return;
      toggleFacilityFlag(button.dataset.id, "visited");
    });

    $("cards")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;

      const card = event.target.closest(".card");
      if (!card) return;

      event.preventDefault();
      const id = card.getAttribute("data-id");
      if (id) location.hash = `detail-${encodeURIComponent(id)}`;
    });

    window.addEventListener("hashchange", route);
  }

  function switchFormTab(tabKey) {
    document.querySelectorAll('.form-section[data-tab]').forEach((section) => {
      section.classList.toggle("tab-active", section.dataset.tab === tabKey);
    });
    document.querySelectorAll("#formTabBar .tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tabTarget === tabKey);
    });
    const dialog = document.querySelector(".dialog");
    if (dialog) dialog.scrollTop = 0;
  }

  // ---------------------------------------------------------
  // 浴場情報・サウナ関連・シャワー/アメニティ・ロッカー/靴箱の
  // 男女共通入力モード（男性側の入力内容を女性側にも自動反映する）
  // ---------------------------------------------------------

  const GENDER_COMMON_PAIRS = [
    { pair: "facility", maleTab: "facility-male", femaleTab: "facility-female" },
    { pair: "sauna", maleTab: "sauna-male", femaleTab: "sauna-female" },
    { pair: "amenity", maleTab: "amenity-male", femaleTab: "amenity-female" },
    { pair: "locker", maleTab: "locker-male", femaleTab: "locker-female" }
  ];

  function getGenderSectionFields(tabKey) {
    const section = document.querySelector(`.form-section[data-tab="${tabKey}"]`);
    if (!section) return [];
    return Array.from(section.querySelectorAll("input, textarea, select"));
  }

  // 男性側の入力内容を、同じ並び順の女性側フィールドにそのままコピーする
  function mirrorGenderSection(maleTab, femaleTab) {
    const maleFields = getGenderSectionFields(maleTab);
    const femaleFields = getGenderSectionFields(femaleTab);
    maleFields.forEach((mEl, i) => {
      const fEl = femaleFields[i];
      if (!fEl) return;
      if (mEl.type === "checkbox" || mEl.type === "radio") {
        if (fEl.checked !== mEl.checked) {
          fEl.checked = mEl.checked;
        }
      } else if (fEl.value !== mEl.value) {
        fEl.value = mEl.value;
      }
    });
  }

  function mirrorAllGenderSections() {
    GENDER_COMMON_PAIRS.forEach(({ maleTab, femaleTab }) => mirrorGenderSection(maleTab, femaleTab));
  }

  // 編集時：男女の入力内容がすべて一致していれば共通モード、
  // 1つでも異なっていれば既存データを壊さないよう男女別モードにする
  function sectionsAreEqual(maleTab, femaleTab) {
    const maleFields = getGenderSectionFields(maleTab);
    const femaleFields = getGenderSectionFields(femaleTab);
    if (maleFields.length !== femaleFields.length) return false;
    return maleFields.every((mEl, i) => {
      const fEl = femaleFields[i];
      if (!fEl) return false;
      if (mEl.type === "checkbox" || mEl.type === "radio") return mEl.checked === fEl.checked;
      return mEl.value === fEl.value;
    });
  }

  function detectGenderCommonModeFromData() {
    return GENDER_COMMON_PAIRS.every(({ maleTab, femaleTab }) => sectionsAreEqual(maleTab, femaleTab));
  }

  function applyGenderCommonModeUI() {
    const isCommon = !!$("genderCommonModeToggle")?.checked;
    let needTabSwitch = false;

    document.querySelectorAll("#formTabBar .tab-btn[data-gender-common-pair]").forEach((btn) => {
      const commonLabel = btn.dataset.genderCommonLabel;
      if (commonLabel) btn.textContent = isCommon ? commonLabel : btn.dataset.originalLabel || btn.textContent;
    });

    document.querySelectorAll("#formTabBar .tab-btn[data-gender-common-hide]").forEach((btn) => {
      btn.classList.toggle("hidden", isCommon);
      if (isCommon && btn.classList.contains("active")) needTabSwitch = true;
    });

    if (isCommon) mirrorAllGenderSections();

    if (needTabSwitch) {
      const hiddenTarget = document.querySelector("#formTabBar .tab-btn.active[data-gender-common-hide]");
      const pairKey = hiddenTarget?.dataset.genderCommonHide;
      const maleBtn = pairKey
        ? document.querySelector(`#formTabBar .tab-btn[data-gender-common-pair="${pairKey}"]`)
        : null;
      switchFormTab(maleBtn?.dataset.tabTarget || "basic");
    }
  }

  // 元のラベル（🚹 男性 ○○）を保持しておき、共通モードOFFで戻せるようにする
  document.querySelectorAll("#formTabBar .tab-btn[data-gender-common-pair]").forEach((btn) => {
    btn.dataset.originalLabel = btn.textContent;
  });

  $("genderCommonModeToggle")?.addEventListener("change", applyGenderCommonModeUI);

  GENDER_COMMON_PAIRS.forEach(({ maleTab, femaleTab }) => {
    const section = document.querySelector(`.form-section[data-tab="${maleTab}"]`);
    section?.addEventListener("input", () => {
      if ($("genderCommonModeToggle")?.checked) mirrorGenderSection(maleTab, femaleTab);
    });
    section?.addEventListener("change", () => {
      if ($("genderCommonModeToggle")?.checked) mirrorGenderSection(maleTab, femaleTab);
    });
  });

  function closeModal() {
    const modal = $("modal");
    if (!modal) return;

    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    document.querySelector("#modal .dialog")?.scrollTo(0, 0);
    $("scrollToTopButton")?.classList.add("hidden");

    // 編集状態やフォームの内容が残らないよう、閉じるたびに初期状態へ戻す
    editingId = null;
    resetForm();
    const titleEl = $("modalTitle");
    if (titleEl) titleEl.textContent = "施設を追加";
    const submitButton = document.querySelector('#form button[type="submit"]');
    if (submitButton) submitButton.textContent = "登録する";
  }

  // renderCardsをデータ保持にも対応させる
  // ---------------------------------------------------------
  // 地図（Leaflet / OpenStreetMap）
  // ---------------------------------------------------------

  let leafletMap = null;
  let leafletMarkerGroup = null;
  let currentTileLayer = null;
  let currentMapStyle = "aerial";

  const TILE_LAYER_CONFIGS = {
    aerial: {
      url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
      options: {
        maxZoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル（航空写真）</a>'
      }
    },
    osm: {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
      }
    }
  };

  function applyMapStyle(style) {
    if (!leafletMap) return;

    const config = TILE_LAYER_CONFIGS[style] || TILE_LAYER_CONFIGS.aerial;

    if (currentTileLayer) {
      leafletMap.removeLayer(currentTileLayer);
    }
    currentTileLayer = L.tileLayer(config.url, config.options).addTo(leafletMap);
    currentMapStyle = style;

    const toggleButton = $("mapStyleToggleButton");
    if (toggleButton) {
      toggleButton.textContent =
        style === "aerial"
          ? "🗺 通常マップに変更"
          : "🗺 航空写真に変更";
    }
  }

  function initMap() {
    if (leafletMap || !window.L || !$("mapContainer")) return;

    leafletMap = L.map("mapContainer").setView([36.5, 138.0], 5);

    const mapboxToken = window.ONSEN_MAPBOX_CONFIG?.accessToken;

    if (mapboxToken) {
      L.tileLayer(
        `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}?access_token=${mapboxToken}`,
        {
          maxZoom: 22,
          tileSize: 512,
          zoomOffset: -1,
          attribution:
            '&copy; <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener">Mapbox</a> ' +
            '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
        }
      ).addTo(leafletMap);
      $("mapStyleToggleButton")?.classList.add("hidden");
    } else {
      applyMapStyle("aerial");
    }

    leafletMarkerGroup = L.layerGroup().addTo(leafletMap);
    leafletMap.on("zoomend", () => {
      renderMapMarkers(lastMapItems);
    });
    renderMapLegend();
  }

  function renderMapLegend() {
    const legend = $("mapLegend");
    if (!legend) return;
    legend.innerHTML = Object.entries(BUSINESS_TYPE_STYLES)
      .map(
        ([type, style]) => `
          <span class="map-legend-item">
            <span class="map-legend-dot" style="background:${style.bg}${style.border ? `;border:${style.border}` : ""}">${style.emoji}</span>
            ${escapeHtml(businessTypeDisplayLabel(type))}
          </span>
        `
      )
      .join("");
  }

  // ---------------------------------------------------------
  // Googleマップのリンクから緯度経度を抽出
  // ---------------------------------------------------------

  // ---------------------------------------------------------
  // 現在地・距離計算
  // ---------------------------------------------------------

  function distanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  window.__userLocation = null;
  let currentLocationMarker = null;

  function requestUserLocation({ recenter = false } = {}) {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      (position) => {
        window.__userLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };

        renderCardsWithData(window.__onsenData);

        if (leafletMap && window.L) {
          if (currentLocationMarker) {
            currentLocationMarker.remove();
          }
          currentLocationMarker = L.circleMarker(
            [window.__userLocation.lat, window.__userLocation.lng],
            {
              radius: 8,
              color: "#fff",
              weight: 2,
              fillColor: "#3b6fd6",
              fillOpacity: 1
            }
          )
            .bindPopup("📍 現在地")
            .addTo(leafletMap);

          if (recenter) {
            leafletMap.setView([window.__userLocation.lat, window.__userLocation.lng], 13);
          }
        }
      },
      (error) => {
        console.error("現在地の取得に失敗:", error);
        if (recenter) {
          const reasons = {
            1: "位置情報の利用が許可されていません。",
            2: "現在地を特定できませんでした（電波状況やGPSの問題の可能性があります）。",
            3: "位置情報の取得がタイムアウトしました。電波の良い場所でもう一度お試しください。"
          };
          alert(
            "現在地を取得できませんでした。\n\n" +
            (reasons[error.code] || `詳細：${error.message || "不明なエラー"}`)
          );
        }
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }

  function extractLatLngFromGoogleMapsUrl(url) {
    if (!url) return null;

    // ピンそのものの正確な座標（!3d緯度!4d経度）を最優先
    let match = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (match) return { lat: match[1], lng: match[2] };

    // 表示中心の座標（/@緯度,経度,ズーム/）
    match = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (match) return { lat: match[1], lng: match[2] };

    // クエリパラメータ形式（?q=緯度,経度 / &ll=緯度,経度）
    match = url.match(/[?&](?:q|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (match) return { lat: match[1], lng: match[2] };

    return null;
  }

  function buildMapPinIcon(businessType, name, highlighted = false) {
    const style = BUSINESS_TYPE_STYLES[businessType] || {
      emoji: "📍",
      bg: "#8a968f"
    };

    const html = `
      <div class="map-pin${highlighted ? " map-pin-highlighted" : ""}">
        <div class="map-pin-head" style="background:${style.bg}">${style.emoji}</div>
        <div class="map-pin-tip" style="border-top-color:${style.bg}"></div>
      </div>
    `;

    return L.divIcon({
      html,
      className: "map-pin-wrapper",
      iconSize: [34, 46],
      iconAnchor: [17, 46],
      popupAnchor: [0, -44]
    });
  }

  function showFacilityOnMap(id) {
    if (!id) return;
    highlightedFacilityId = id;

    const data = window.__onsenData || getLocalData();
    renderCardsWithData(data);

    $("mapSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderMapMarkers(items) {
    if (!leafletMap || !leafletMarkerGroup) return null;

    leafletMarkerGroup.clearLayers();

    // 表示中の施設のうち、登録済みの「温泉地」に属するものをグループ化する
    const itemById = {};
    items.forEach((item) => {
      itemById[item.id] = item;
    });

    const facilityToArea = {};
    onsenAreasForMap.forEach((area) => {
      (area.facility_ids || []).forEach((id) => {
        if (itemById[id] && !facilityToArea[id]) {
          facilityToArea[id] = area;
        }
      });
    });

    const areaGroupsById = {};
    const individualItems = [];
    items.forEach((item) => {
      const area = facilityToArea[item.id];
      if (!area) {
        individualItems.push(item);
        return;
      }
      if (!areaGroupsById[area.id]) {
        areaGroupsById[area.id] = { area, items: [] };
      }
      areaGroupsById[area.id].items.push(item);
    });

    const currentZoom = leafletMap.getZoom();
    const isWideView = currentZoom < AREA_CLUSTER_ZOOM_THRESHOLD;

    let highlightedMarker = null;

    function addIndividualPin(item) {
      const isHighlighted = String(item.id) === String(highlightedFacilityId);
      const marker = L.marker([Number(item.lat), Number(item.lng)], {
        icon: buildMapPinIcon(item.business_type, item.name || "名称未設定", isHighlighted),
        zIndexOffset: isHighlighted ? 1000 : 0
      });

      const name = escapeHtml(item.name || "名称未設定");
      const place = escapeHtml([item.prefecture, item.area].filter(Boolean).join(" "));
      const status = getOpenStatus(item);
      const mapsUrl = item.google_maps_url
        ? item.google_maps_url
        : `https://www.google.com/maps?q=${item.lat},${item.lng}`;

      marker.bindPopup(
        `<div class="map-popup">
          <b>${name}</b>
          ${place ? `<p class="map-popup-place">📍 ${place}</p>` : ""}
          ${status ? `<span class="status-badge ${status.className}">${escapeHtml(status.label)}</span>` : ""}
          <div class="map-popup-links">
            <a href="#detail-${encodeURIComponent(item.id)}">施設詳細を見る</a>
            <a href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener">Googleマップで見る</a>
          </div>
        </div>`
      );
      marker.addTo(leafletMarkerGroup);

      if (isHighlighted) highlightedMarker = marker;
    }

    individualItems.forEach(addIndividualPin);

    Object.values(areaGroupsById).forEach(({ area, items: groupItems }) => {
      const isHighlighted = groupItems.some((it) => String(it.id) === String(highlightedFacilityId));

      // 拡大表示中、またはハイライト中の施設を含む場合は個別ピンで表示
      if (!isWideView || isHighlighted) {
        groupItems.forEach(addIndividualPin);
        return;
      }

      // 広域表示：施設全体を囲む円＋件数＋温泉地名のラベルで表示
      const lat = groupItems.reduce((sum, it) => sum + Number(it.lat), 0) / groupItems.length;
      const lng = groupItems.reduce((sum, it) => sum + Number(it.lng), 0) / groupItems.length;
      const maxDistKm = Math.max(
        ...groupItems.map((it) => distanceKm(lat, lng, Number(it.lat), Number(it.lng))),
        0.1
      );
      const radiusMeters = Math.max(maxDistKm * 1000 * 1.3, 400);

      const circle = L.circle([lat, lng], {
        radius: radiusMeters,
        color: "#e0392b",
        weight: 2,
        fillColor: "#e0392b",
        fillOpacity: 0.22
      });

      const popupId = `cluster-zoom-${area.id}`;
      circle.bindPopup(
        `<div class="map-popup">
          <b>♨️ ${escapeHtml(area.name)}</b>
          <p class="map-popup-place">${groupItems.length}件の施設があります</p>
          <button type="button" class="map-cluster-zoom-btn" id="${popupId}">さらに拡大する</button>
        </div>`
      );
      circle.on("popupopen", () => {
        $(popupId)?.addEventListener("click", () => {
          const bounds = L.latLngBounds(groupItems.map((it) => [Number(it.lat), Number(it.lng)]));
          leafletMap.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
        });
      });
      circle.addTo(leafletMarkerGroup);

      const countMarker = L.marker([lat, lng], {
        icon: L.divIcon({
          html: `<div class="map-cluster-count">${groupItems.length}</div>`,
          className: "map-cluster-count-wrapper",
          iconSize: [0, 0],
          iconAnchor: [0, 0]
        }),
        interactive: false
      });
      countMarker.addTo(leafletMarkerGroup);
    });

    return highlightedMarker;
  }

  function updateMap(list) {
    if (!window.L || !$("mapContainer")) return;
    if (!leafletMap) initMap();
    if (!leafletMap || !leafletMarkerGroup) return;

    const items = (Array.isArray(list) ? list : []).filter(
      (item) => item.lat != null && item.lng != null && !Number.isNaN(Number(item.lat)) && !Number.isNaN(Number(item.lng))
    );
    lastMapItems = items;

    const mapCount = $("mapCount");
    if (mapCount) {
      mapCount.textContent = items.length ? `${items.length}件表示中` : "";
    }

    const highlightedMarker = renderMapMarkers(items);

    if (highlightedMarker) {
      leafletMap.setView(highlightedMarker.getLatLng(), 15);
      setTimeout(() => highlightedMarker.openPopup(), 300);
    } else if (items.length) {
      const bounds = L.latLngBounds(items.map((item) => [Number(item.lat), Number(item.lng)]));
      leafletMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
    } else {
      leafletMap.setView([36.5, 138.0], 5);
    }

    // 地図の表示エリアが確定してからサイズを再計算する
    setTimeout(() => leafletMap.invalidateSize(), 0);
  }

  const originalRenderCards = renderCards;

  window.__onsenData = [];

  function updateFacilityCount(list) {
    const el = $("facilityCount");
    if (!el) return;
    el.textContent = Array.isArray(list) ? String(list.length) : "0";
  }

  function renderCardsWithData(list) {
    window.__onsenData = Array.isArray(list) ? list : [];
    originalRenderCards(window.__onsenData);
    updateMap(getFilteredSortedList(window.__onsenData));
    updateFacilityCount(window.__onsenData);
  }

  // ---------------------------------------------------------
  // 起動
  // ---------------------------------------------------------

  async function checkSitePublic() {
    if (!supabaseClient) return true;

    try {
      const { data, error } = await supabaseClient
        .from("site_settings")
        .select("is_public, maintenance_message")
        .eq("id", 1)
        .single();

      if (error) return true; // テーブル未設定などの場合は通常表示を優先
      if (data && data.is_public === false) {
        const main = document.querySelector("main");
        const hero = $("heroSection");
        if (main) {
          main.innerHTML = `
            <div class="site-offline">
              <p>🚧 現在サイトは非公開になっています。</p>
              ${data.maintenance_message ? `<p>${escapeHtml(data.maintenance_message)}</p>` : ""}
            </div>
          `;
        }
        hero?.classList.add("hidden");
        return false;
      }
      return true;
    } catch (error) {
      console.error(error);
      return true;
    }
  }

  const APP_STATE_KEY = "onsenAppState";

  function saveAppState() {
    try {
      const state = {
        search: value("search"),
        sortMode: $("sortModeSelect")?.value || "distance",
        facetFilters: window.__activeFacetFilters || null
      };
      localStorage.setItem(APP_STATE_KEY, JSON.stringify(state));
    } catch (error) {
      console.error("状態の保存に失敗:", error);
    }
  }

  function restoreAppState() {
    try {
      const raw = localStorage.getItem(APP_STATE_KEY);
      if (!raw) return;
      const state = JSON.parse(raw);

      if (state.search && $("search")) {
        $("search").value = state.search;
      }
      if (state.sortMode && $("sortModeSelect")) {
        $("sortModeSelect").value = state.sortMode;
      }
      if (state.facetFilters) {
        window.__activeFacetFilters = state.facetFilters;
      }
    } catch (error) {
      console.error("状態の復元に失敗:", error);
    }
  }

  // iOSでキーボード表示時にposition:fixedのモーダルがずれるのを防ぐため、
  // 見えている範囲（ビジュアルビューポート）に高さ・位置を追従させる
  function syncViewportSizeVars() {
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    document.documentElement.style.setProperty("--app-vv-height", `${height}px`);
    document.documentElement.style.setProperty("--app-vv-top", `${top}px`);
  }
  syncViewportSizeVars();
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewportSizeVars);
    window.visualViewport.addEventListener("scroll", syncViewportSizeVars);
  } else {
    window.addEventListener("resize", syncViewportSizeVars);
  }

  async function start() {
    setupEvents();
    restoreAppState();

    const isPublic = await checkSitePublic();
    if (!isPublic) return;

    // 既存の関数から使えるようにする
    window.onsenApp = {
      loadAll,
      saveOnsen,
      getLocalData,
      collectFormData
    };

    // renderCardsを差し替え
    window.__renderOnsenCards = renderCardsWithData;

    // loadAll内部からは元renderCardsを使うため、
    // ここではデータを取得して直接描画する
    try {
      setStatus("温泉一覧を読み込んでいます…");

      let data = [];

      if (supabaseClient) {
        try {
          data = await loadSupabaseData();
        } catch (error) {
          console.error(error);
        }
      }

      if (!data.length) {
        data = getLocalData();
      }

      window.__onsenData = data;
      originalRenderCards(data);
      updateMigrateBanner();
      updateMap(getFilteredSortedList(data));
      updateFacilityCount(data);

      if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        setStatus(
          data.length
            ? `この端末の保存データ${data.length}件を表示中（Supabase未設定）`
            : "Supabase未設定です。端末保存で登録できます。",
          data.length ? "ok" : ""
        );
      }
    } catch (error) {
      console.error(error);

      const localData = getLocalData();
      window.__onsenData = localData;
      originalRenderCards(localData);
      updateMigrateBanner();
      updateMap(getFilteredSortedList(localData));
      updateFacilityCount(localData);

      setStatus(
        `一覧の読込に失敗しました：${error.message || "不明なエラー"}`,
        "error"
      );
    }

    // URLに #detail-xxx が含まれていれば詳細画面から開始
    route();

    // 現在地が取れれば、一覧を近い順に並び替える
    requestUserLocation();
  }

  // DOMContentLoaded後に開始
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
