// 保存した地点（localStorage）。一覧UIは持たず、地図上の水色の丸とメニューだけで完結する。
import { formatLatLng } from './pin.js';

const STORAGE_KEY = 'ccf-places';

const PLACE_ICON = L.divIcon({
    className: 'place-marker',
    html: '<span class="place-marker-dot" aria-hidden="true"></span>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
});

function loadPlaces() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((p) => p
            && typeof p.id === 'string'
            && Number.isFinite(p.lat)
            && Number.isFinite(p.lng)
            && typeof p.name === 'string'
        ).map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, name: String(p.name) }));
    } catch {
        return [];
    }
}

function savePlaces(places) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(places));
    } catch (e) {
        console.warn('地点の保存に失敗しました', e);
    }
}

function samePoint(a, b) {
    return a.lat.toFixed(5) === Number(b.lat).toFixed(5)
        && a.lng.toFixed(5) === Number(b.lng).toFixed(5);
}

function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class PlacesController {
    // maps: { key: L.Map }
    // pinController: PinController
    // reverseGeocode(lat, lng) → Promise<string|null>
    constructor({ maps, pinController, reverseGeocode }) {
        this.maps = Object.values(maps);
        this.pinController = pinController;
        this.reverseGeocode = reverseGeocode;
        this.places = loadPlaces();
        this.groups = this.maps.map((map) => L.layerGroup().addTo(map));
        this._popup = null;
        this._editingId = null;
        this._draft = null;
        this._dialogSeq = 0;

        this.dialog = document.getElementById('place-name-dialog');
        this.titleEl = document.getElementById('place-name-title');
        this.inputEl = document.getElementById('place-name-input');
        this.formEl = document.getElementById('place-name-form');
        this.cancelEl = document.getElementById('place-name-cancel');

        this._bindDialog();
        this._render();
    }

    // ピンが置かれた・動いた・消えたとき。重なりマーカーの出し分けを更新する
    onPinChange() {
        this.closeMenu();
        this._render();
    }

    findAt(lat, lng) {
        return this.places.find((p) => samePoint(p, { lat, lng })) || null;
    }

    // 赤いピンをタップしたとき
    onPinMarkerClick(pin, map) {
        if (!pin) return;
        const existing = this.findAt(pin.lat, pin.lng);
        if (existing) this._openMenu(map, existing, 'saved');
        else this._openMenu(map, { lat: pin.lat, lng: pin.lng, name: pin.name }, 'pin');
    }

    // 地点バーの「登録／編集」ボタン用。地図クリックに依存しない確実な入口
    openPinAction() {
        const pin = this.pinController.pin;
        if (!pin) return;
        const existing = this.findAt(pin.lat, pin.lng);
        if (existing) this._openEdit(existing);
        else this._openRegister(pin.lat, pin.lng, pin.name);
    }

    // 地点バーボタンのラベルを現在のピンに合わせる
    updatePinActionButton(btn) {
        if (!btn) return;
        const pin = this.pinController.pin;
        if (!pin) {
            btn.hidden = true;
            return;
        }
        btn.hidden = false;
        btn.textContent = this.findAt(pin.lat, pin.lng) ? '編集' : '登録';
    }

    closeMenu() {
        if (this._popup) {
            this._popup.remove();
            this._popup = null;
        }
    }

    _bindDialog() {
        if (!this.dialog || !this.formEl) return;
        this.cancelEl.addEventListener('click', () => this.dialog.close());
        this.formEl.addEventListener('submit', (e) => {
            e.preventDefault();
            this._commitDialog();
        });
        this.dialog.addEventListener('cancel', () => {
            this._editingId = null;
            this._draft = null;
        });
    }

    _openMenu(map, place, kind) {
        this.closeMenu();
        const menu = document.createElement('div');
        menu.className = 'place-menu';
        menu.setAttribute('role', 'menu');

        const addBtn = (label, act) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.dataset.act = act;
            menu.appendChild(btn);
        };
        if (kind === 'pin') addBtn('登録', 'register');
        if (kind === 'saved') {
            addBtn('編集', 'edit');
            addBtn('削除', 'delete');
        }
        addBtn('閉じる', 'close');

        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            const act = btn.dataset.act;
            if (act === 'close') {
                this.closeMenu();
                return;
            }
            if (act === 'register') {
                this.closeMenu();
                this._openRegister(place.lat, place.lng, place.name);
                return;
            }
            if (act === 'edit') {
                this.closeMenu();
                this._openEdit(place);
                return;
            }
            if (act === 'delete') {
                this.closeMenu();
                const label = place.name || formatLatLng(place.lat, place.lng);
                if (!confirm(`${label}を削除して良いですか？`)) return;
                this._delete(place.id);
            }
        });

        this._popup = L.popup({
            className: 'place-menu-popup',
            closeButton: false,
            autoClose: true,
            // 地図 click でメニューを開く経路があるので、同一 click で閉じない
            closeOnClick: false,
            offset: [0, -10],
            maxWidth: 280
        })
            .setLatLng([place.lat, place.lng])
            .setContent(menu)
            .openOn(map);
    }

    async _openRegister(lat, lng, fallbackName) {
        this._editingId = null;
        this._draft = { lat, lng };
        this.titleEl.textContent = '地点を登録';
        const fallback = fallbackName || formatLatLng(lat, lng);
        this.inputEl.value = fallback;
        this.dialog.showModal();
        this.inputEl.focus();
        this.inputEl.select();

        const seq = ++this._dialogSeq;
        try {
            const address = await this.reverseGeocode(lat, lng);
            if (seq !== this._dialogSeq || !this.dialog.open || this._editingId) return;
            if (!address) return;
            // 逆ジオが返る前に手で直していたら上書きしない
            if (this.inputEl.value === fallback || this.inputEl.value === formatLatLng(lat, lng)) {
                this.inputEl.value = address;
                this.inputEl.select();
            }
        } catch (e) {
            console.warn('逆ジオコーディングに失敗しました', e);
        }
    }

    _openEdit(place) {
        this._editingId = place.id;
        this._draft = { lat: place.lat, lng: place.lng };
        this.titleEl.textContent = '地点を編集';
        this.inputEl.value = place.name;
        this.dialog.showModal();
        this.inputEl.focus();
        this.inputEl.select();
        this._dialogSeq += 1;
    }

    _commitDialog() {
        if (!this._draft) {
            this.dialog.close();
            return;
        }
        const { lat, lng } = this._draft;
        const name = this.inputEl.value.trim() || formatLatLng(lat, lng);
        if (this._editingId) {
            const place = this.places.find((p) => p.id === this._editingId);
            if (place) place.name = name;
        } else {
            const existing = this.findAt(lat, lng);
            if (existing) existing.name = name;
            else this.places.push({ id: newId(), lat, lng, name });
        }
        savePlaces(this.places);
        this._editingId = null;
        this._draft = null;
        this.dialog.close();
        this._render();
        // 表示中のピン名も揃える
        const pin = this.pinController.pin;
        if (pin && samePoint(pin, { lat, lng })) {
            this.pinController.rename(name);
            const nameEl = document.getElementById('pin-name');
            if (nameEl) {
                nameEl.textContent = `📍${name}`;
                nameEl.title = name;
            }
        }
        this.updatePinActionButton(document.getElementById('pin-place-btn'));
    }

    _delete(id) {
        this.places = this.places.filter((p) => p.id !== id);
        savePlaces(this.places);
        this._render();
        this.updatePinActionButton(document.getElementById('pin-place-btn'));
    }

    _onPlaceClick(place, map) {
        this.pinController.set(place.lat, place.lng, place.name);
        map.setView([place.lat, place.lng], map.getZoom());
        // set / setView に伴う地図 click より後に出す
        requestAnimationFrame(() => this._openMenu(map, place, 'saved'));
    }

    _render() {
        const pin = this.pinController.pin;
        for (const group of this.groups) group.clearLayers();

        for (const place of this.places) {
            // 赤ピンと同じ地点の保存丸は隠す（重なり対策）
            if (pin && samePoint(place, pin)) continue;

            this.maps.forEach((map, i) => {
                const marker = L.marker([place.lat, place.lng], {
                    icon: PLACE_ICON,
                    zIndexOffset: -200,
                    keyboard: false,
                    bubblingMouseEvents: false
                });
                marker.on('click', (e) => {
                    L.DomEvent.stop(e);
                    this._onPlaceClick(place, map);
                });
                this.groups[i].addLayer(marker);
            });
        }
    }
}
