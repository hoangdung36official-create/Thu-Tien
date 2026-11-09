'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle, ArrowRightLeft, Boxes, Check, ClipboardCheck, History, Package,
  Plus, RefreshCw, RotateCcw, Search, Trash2, Warehouse, Wrench, X
} from 'lucide-react';
import './assets.css';

type User = { id:string; name:string; role:'ADMIN'|'NV'|'KETOAN'; houses:string[] };
type House = { code:string; name:string; active:boolean };
type Asset = { id:string; code:string; category:string; name:string; brand:string; model:string; purchaseDate:string|null; purchaseCost:number|null; warrantyUntil:string|null; conditionPct:number; status:string; locationType:string; houseCode:string|null; room:string|null; note:string; imageUrl:string|null; version:number };
type Supply = { id:string; sku:string; name:string; category:string; unit:string; referencePrice:number|null; minimumQty:number; active:boolean; balances:{locationKey:string;quantity:number}[] };
type StockRow = { id:string; locationKey:string; quantity:number; supply:{sku:string;name:string;unit:string;minimumQty:number}; supplyId?:string };
type Rental = { id:string; assetId:string; houseCode:string; room:string; startAt:string; expectedEndAt:string|null; endedAt:string|null; monthlyFee:number|null; included:boolean; asset:{code:string;name:string} };
type Count = { id:string; locationKey:string; status:string; note:string; createdAt:string; lines:{id:string;expectedQty:number;actualQty:number;supply:{sku:string;name:string;unit:string}}[] };
type Maintenance = { id:string; assetId:string; kind:string; status:string; description:string; cost:number|null; startedAt:string; completedAt:string|null; note:string; asset:{code:string;name:string;houseCode:string|null} };
type HistoryRow = { id:string; type:string; subject:string; operation:string; reason:string; createdAt:string };
type Overview = { totalAssets:number; available:number; rented:number; repairing:number; purchaseValue:number|null; activeRentals:number; monthlyEstimate:number|null; expiringWarranty:number; lowStock:number; openCounts:number; byHouse:Record<string,number>; byCategory:Record<string,number> };
type Section = 'overview'|'items'|'stock'|'rentals'|'counts'|'maintenance'|'history';
type Drawer = 'asset'|'move'|'rental'|'return'|'supply'|'stock'|'count'|'maintenance'|'dispose'|null;

const cash = (value:number|null|undefined) => value == null ? '—' : new Intl.NumberFormat('vi-VN').format(value) + ' đ';
const isoDay = (value:string|null|undefined) => value ? value.slice(0,10) : '';
const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const uuid = () => crypto.randomUUID();
const statusLabel:Record<string,string> = { AVAILABLE:'Sẵn sàng', RENTED:'Đang cho thuê', REPAIR:'Đang sửa', DISPOSED:'Đã thanh lý', OPEN:'Đang xử lý', DONE:'Hoàn tất', DRAFT:'Chờ duyệt', APPROVED:'Đã duyệt' };

async function req<T>(path:string, init?:RequestInit):Promise<T>{
  const response = await fetch('/api'+path,{credentials:'same-origin',cache:'no-store',...init,headers:{...(init?.body?{'Content-Type':'application/json'}:{}),...init?.headers}});
  if(!response.ok){
    const body = await response.json().catch(()=>({}));
    throw new Error(body.error || `Yêu cầu lỗi ${response.status}`);
  }
  return response.json();
}
const send = <T,>(path:string, body:unknown, method='POST') => req<T>(path,{method,body:JSON.stringify(body)});

const emptyAsset = { category:'Tủ lạnh', name:'', brand:'', model:'', purchaseDate:'', purchaseCost:'', warrantyUntil:'', conditionPct:'100', note:'', imageUrl:'', locationType:'BUILDING', houseCode:'', room:'' };

export function Assets({user,houses}:{user:User;houses:House[]}){
  const admin = user.role === 'ADMIN';
  const writable = user.role !== 'KETOAN';
  const activeHouses = useMemo(()=>houses.filter(h=>h.active && (admin || user.houses.includes(h.code))),[houses,admin,user.houses]);
  const [section,setSection] = useState<Section>('overview');
  const [drawer,setDrawer] = useState<Drawer>(null);
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [search,setSearch] = useState('');
  const [houseFilter,setHouseFilter] = useState('');
  const [overview,setOverview] = useState<Overview|null>(null);
  const [items,setItems] = useState<Asset[]>([]);
  const [supplies,setSupplies] = useState<Supply[]>([]);
  const [stock,setStock] = useState<StockRow[]>([]);
  const [rentals,setRentals] = useState<Rental[]>([]);
  const [counts,setCounts] = useState<Count[]>([]);
  const [maintenance,setMaintenance] = useState<Maintenance[]>([]);
  const [history,setHistory] = useState<HistoryRow[]>([]);
  const [selected,setSelected] = useState<Asset|null>(null);
  const [selectedRental,setSelectedRental] = useState<Rental|null>(null);
  const [assetForm,setAssetForm] = useState({...emptyAsset});
  const [editingId,setEditingId] = useState('');
  const [moveForm,setMoveForm] = useState({locationType:'BUILDING',houseCode:'',room:'',reason:'Điều chuyển tài sản'});
  const [rentalForm,setRentalForm] = useState({assetId:'',houseCode:'',room:'',startAt:today(),expectedEndAt:'',monthlyFee:'0',included:false,handoverNote:''});
  const [returnForm,setReturnForm] = useState({endedAt:today(),note:'',locationType:'BUILDING',houseCode:'',room:''});
  const [supplyForm,setSupplyForm] = useState({sku:'',name:'',category:'Vật tư kỹ thuật',unit:'cái',referencePrice:'0',minimumQty:'0',note:''});
  const [stockForm,setStockForm] = useState({supplyId:'',operation:'IN',quantity:'1',fromKey:'',toKey:'',reason:'',workRef:''});
  const [countLocation,setCountLocation] = useState('');
  const [countActuals,setCountActuals] = useState<Record<string,string>>({});
  const [maintenanceForm,setMaintenanceForm] = useState({assetId:'',kind:'REPAIR',description:'',cost:'0',note:''});
  const [disposeReason,setDisposeReason] = useState('');

  const locationOptions = useMemo(()=>[
    ...(admin?[{value:'CENTRAL',label:'Kho tổng'}]:[]),
    ...activeHouses.map(h=>({value:`BUILDING:${h.code}`,label:`Kho ${h.name || h.code}`}))
  ],[admin,activeHouses]);

  async function refresh(){
    setLoading(true); setError('');
    try{
      const [o,a,s,st,r,c,m,h] = await Promise.all([
        req<Overview>('/assets/overview'),
        req<{rows:Asset[]}>('/assets/items?size=100'),
        req<{rows:Supply[]}>('/assets/supplies?size=100'),
        req<{rows:StockRow[]}>('/assets/stock?size=100'),
        req<{rows:Rental[]}>('/assets/rentals?size=100&active=all'),
        req<{rows:Count[]}>('/assets/counts?size=100'),
        req<{rows:Maintenance[]}>('/assets/maintenance?size=100'),
        req<{rows:HistoryRow[]}>('/assets/history?size=100')
      ]);
      setOverview(o); setItems(a.rows); setSupplies(s.rows); setStock(st.rows); setRentals(r.rows); setCounts(c.rows); setMaintenance(m.rows); setHistory(h.rows);
    }catch(e){ setError(e instanceof Error?e.message:String(e)); }
    finally{ setLoading(false); }
  }
  useEffect(()=>{ void refresh(); },[]);
  useEffect(()=>{ if(!notice)return; const t=setTimeout(()=>setNotice(''),3500); return()=>clearTimeout(t); },[notice]);

  async function act(run:()=>Promise<unknown>, ok:string){
    if(busy)return;
    setBusy(true); setError('');
    try{ await run(); setDrawer(null); setNotice(ok); await refresh(); }
    catch(e){ setError(e instanceof Error?e.message:String(e)); }
    finally{ setBusy(false); }
  }

  function newAsset(){
    setEditingId(''); setSelected(null);
    setAssetForm({...emptyAsset,houseCode:activeHouses[0]?.code||'',locationType:admin?'CENTRAL':'BUILDING'});
    setDrawer('asset');
  }
  function editAsset(item:Asset){
    setSelected(item); setEditingId(item.id);
    setAssetForm({category:item.category,name:item.name,brand:item.brand,model:item.model,purchaseDate:isoDay(item.purchaseDate),purchaseCost:item.purchaseCost==null?'':String(item.purchaseCost),warrantyUntil:isoDay(item.warrantyUntil),conditionPct:String(item.conditionPct),note:item.note,imageUrl:item.imageUrl||'',locationType:item.locationType,houseCode:item.houseCode||'',room:item.room||''});
    setDrawer('asset');
  }
  async function saveAsset(e:FormEvent){
    e.preventDefault();
    const body:any = {category:assetForm.category,name:assetForm.name,brand:assetForm.brand,model:assetForm.model,purchaseDate:assetForm.purchaseDate||null,warrantyUntil:assetForm.warrantyUntil||null,conditionPct:Number(assetForm.conditionPct),note:assetForm.note,imageUrl:assetForm.imageUrl||null};
    if(admin) body.purchaseCost = assetForm.purchaseCost===''?null:Number(assetForm.purchaseCost);
    if(editingId && selected){
      body.expectedVersion = selected.version;
      await act(()=>send(`/assets/items/${editingId}`,body,'PATCH'),'Đã cập nhật tài sản');
    }else{
      Object.assign(body,{locationType:assetForm.locationType,houseCode:assetForm.locationType==='CENTRAL'?null:assetForm.houseCode||null,room:assetForm.locationType==='ROOM'?assetForm.room||null:null});
      await act(()=>send('/assets/items',body),'Đã tạo tài sản');
    }
  }
  function openMove(item:Asset){ setSelected(item); setMoveForm({locationType:item.locationType==='CENTRAL'?'BUILDING':item.locationType,houseCode:item.houseCode||activeHouses[0]?.code||'',room:item.room||'',reason:'Điều chuyển tài sản'}); setDrawer('move'); }
  function openRental(item:Asset){ setSelected(item); setRentalForm({assetId:item.id,houseCode:item.houseCode||activeHouses[0]?.code||'',room:item.room||'',startAt:today(),expectedEndAt:'',monthlyFee:'0',included:false,handoverNote:''}); setDrawer('rental'); }
  function openMaintenance(item:Asset){ setSelected(item); setMaintenanceForm({assetId:item.id,kind:'REPAIR',description:'',cost:'0',note:''}); setDrawer('maintenance'); }

  const filteredItems = useMemo(()=>items.filter(item=>{
    const term=search.trim().toLocaleLowerCase('vi');
    return (!houseFilter||item.houseCode===houseFilter) && (!term||`${item.code} ${item.name} ${item.brand} ${item.model}`.toLocaleLowerCase('vi').includes(term));
  }),[items,search,houseFilter]);
  const activeRentals = rentals.filter(r=>!r.endedAt);
  const countRows = stock.filter(row=>row.locationKey===countLocation);

  const tabs:{id:Section;label:string;Icon:any}[] = [
    {id:'overview',label:'Tổng quan',Icon:Boxes},{id:'items',label:'Tài sản',Icon:Package},{id:'stock',label:'Kho',Icon:Warehouse},
    {id:'rentals',label:'Cho thuê',Icon:ArrowRightLeft},{id:'counts',label:'Kiểm kê',Icon:ClipboardCheck},{id:'maintenance',label:'Bảo trì',Icon:Wrench},{id:'history',label:'Lịch sử',Icon:History}
  ];

  return <div className="asset-module">
    <div className="asset-toolbar">
      <div className="asset-tabs">{tabs.map(t=><button key={t.id} className={section===t.id?'active':''} onClick={()=>setSection(t.id)}><t.Icon size={16}/><span>{t.label}</span></button>)}</div>
      <button className="asset-refresh" onClick={()=>void refresh()} disabled={loading||busy} aria-label="Làm mới"><RefreshCw size={17}/></button>
    </div>

    {error&&<div className="asset-alert error"><AlertTriangle size={17}/><span>{error}</span><button onClick={()=>setError('')}><X size={16}/></button></div>}
    {notice&&<div className="asset-alert ok"><Check size={17}/><span>{notice}</span></div>}
    {user.role==='KETOAN'&&<div className="asset-readonly">Tài khoản kế toán đang ở chế độ xem và đối soát tài sản.</div>}

    {loading?<div className="asset-loading">Đang tải dữ liệu tài sản…</div>:<>
      {section==='overview'&&overview&&<>
        <div className="asset-kpis">
          <div className="asset-kpi featured"><span>Tổng tài sản</span><strong>{overview.totalAssets}</strong><small>{overview.available} sẵn sàng · {overview.rented} đang thuê</small></div>
          {admin&&<div className="asset-kpi"><span>Giá trị mua</span><strong>{cash(overview.purchaseValue)}</strong><small>Dữ liệu khai báo tài sản</small></div>}
          <div className="asset-kpi"><span>Đang sửa chữa</span><strong>{overview.repairing}</strong><small>{overview.expiringWarranty} sắp hết bảo hành</small></div>
          <div className="asset-kpi"><span>Vật tư sắp hết</span><strong>{overview.lowStock}</strong><small>{overview.openCounts} kiểm kê chờ duyệt</small></div>
          {admin&&<div className="asset-kpi"><span>Thuê dự kiến/tháng</span><strong>{cash(overview.monthlyEstimate)}</strong><small>{overview.activeRentals} thiết bị đang thuê</small></div>}
        </div>
        <div className="asset-overview-grid">
          <section className="asset-panel"><div className="asset-panel-head"><div><h3>Tài sản theo tòa</h3><p>Vị trí hiện tại của thiết bị</p></div></div><div className="asset-bars">{Object.entries(overview.byHouse).sort((a,b)=>b[1]-a[1]).map(([name,value])=><div key={name}><span>{name}</span><div><i style={{width:`${overview.totalAssets?Math.max(8,value/overview.totalAssets*100):0}%`}}/></div><b>{value}</b></div>)}</div></section>
          <section className="asset-panel"><div className="asset-panel-head"><div><h3>Theo nhóm tài sản</h3><p>Cơ cấu thiết bị đang quản lý</p></div></div><div className="asset-category-list">{Object.entries(overview.byCategory).sort((a,b)=>b[1]-a[1]).map(([name,value])=><div key={name}><span>{name}</span><strong>{value}</strong></div>)}</div></section>
        </div>
      </>}

      {section==='items'&&<section className="asset-panel">
        <div className="asset-panel-head"><div><h3>Danh sách tài sản</h3><p>{filteredItems.length} thiết bị trong phạm vi quản lý</p></div>{writable&&<button className="primary" onClick={newAsset}><Plus size={16}/> Thêm tài sản</button>}</div>
        <div className="asset-filters"><label><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Tìm mã, tên, hãng, model"/></label><select value={houseFilter} onChange={e=>setHouseFilter(e.target.value)}><option value="">Tất cả tòa nhà</option>{activeHouses.map(h=><option key={h.code} value={h.code}>{h.name||h.code}</option>)}</select></div>
        <div className="asset-card-grid">{filteredItems.map(item=><article className="asset-card" key={item.id}>
          <div className="asset-card-top"><div><span className="asset-code">{item.code}</span><h4>{item.name}</h4><p>{[item.brand,item.model].filter(Boolean).join(' · ')||item.category}</p></div><span className={'asset-state '+item.status.toLowerCase()}>{statusLabel[item.status]||item.status}</span></div>
          <dl><div><dt>Vị trí</dt><dd>{item.locationType==='CENTRAL'?'Kho tổng':item.houseCode?`${item.houseCode}${item.room?' · P.'+item.room:''}`:item.locationType}</dd></div><div><dt>Tình trạng</dt><dd>{item.conditionPct}%</dd></div>{admin&&<div><dt>Giá trị</dt><dd>{cash(item.purchaseCost)}</dd></div>}<div><dt>Bảo hành</dt><dd>{isoDay(item.warrantyUntil)||'—'}</dd></div></dl>
          {writable&&item.status!=='DISPOSED'&&<div className="asset-actions"><button onClick={()=>editAsset(item)}>Sửa</button><button onClick={()=>openMove(item)} disabled={item.status==='RENTED'}>Điều chuyển</button><button onClick={()=>openRental(item)} disabled={item.status!=='AVAILABLE'}>Cho thuê</button><button onClick={()=>openMaintenance(item)} disabled={item.status!=='AVAILABLE'}>Bảo trì</button>{admin&&<button className="danger" onClick={()=>{setSelected(item);setDisposeReason('');setDrawer('dispose')}}>Thanh lý</button>}</div>}
        </article>)}</div>
      </section>}

      {section==='stock'&&<section className="asset-panel">
        <div className="asset-panel-head"><div><h3>Kho vật tư</h3><p>Theo dõi tồn kho và nghiệp vụ nhập xuất</p></div><div className="asset-head-actions">{admin&&<button className="secondary" onClick={()=>setDrawer('supply')}><Plus size={15}/> Vật tư</button>}{writable&&<button className="primary" onClick={()=>{setStockForm({...stockForm,supplyId:supplies[0]?.id||'',toKey:locationOptions[0]?.value||''});setDrawer('stock')}}><ArrowRightLeft size={15}/> Nhập / xuất</button>}</div></div>
        <div className="asset-stock-list">{stock.map(row=><div key={row.id}><div><strong>{row.supply.name}</strong><small>{row.supply.sku} · {row.locationKey}</small></div><div className={row.quantity<=row.supply.minimumQty?'low':''}><strong>{row.quantity}</strong><small>{row.supply.unit}</small></div></div>)}</div>
      </section>}

      {section==='rentals'&&<section className="asset-panel"><div className="asset-panel-head"><div><h3>Thiết bị cho thuê</h3><p>{activeRentals.length} lượt thuê đang hoạt động</p></div></div><div className="asset-card-grid">{rentals.map(r=><article className="asset-card" key={r.id}><div className="asset-card-top"><div><span className="asset-code">{r.asset.code}</span><h4>{r.asset.name}</h4><p>{r.houseCode} · Phòng {r.room}</p></div><span className={'asset-state '+(r.endedAt?'done':'rented')}>{r.endedAt?'Đã trả':'Đang thuê'}</span></div><dl><div><dt>Bắt đầu</dt><dd>{isoDay(r.startAt)}</dd></div><div><dt>Kết thúc</dt><dd>{isoDay(r.endedAt)||isoDay(r.expectedEndAt)||'—'}</dd></div>{admin&&<div><dt>Phí/tháng</dt><dd>{r.included?'Trang bị sẵn':cash(r.monthlyFee)}</dd></div>}</dl>{writable&&!r.endedAt&&<div className="asset-actions"><button onClick={()=>{setSelectedRental(r);setReturnForm({endedAt:today(),note:'',locationType:'BUILDING',houseCode:r.houseCode,room:''});setDrawer('return')}}><RotateCcw size={14}/> Thu hồi</button></div>}</article>)}</div></section>}

      {section==='counts'&&<section className="asset-panel"><div className="asset-panel-head"><div><h3>Kiểm kê</h3><p>Đối chiếu tồn kho thực tế với hệ thống</p></div>{writable&&<button className="primary" onClick={()=>{setCountLocation(locationOptions[0]?.value||'');setCountActuals({});setDrawer('count')}}><ClipboardCheck size={15}/> Tạo kiểm kê</button>}</div><div className="asset-count-list">{counts.map(c=><div key={c.id}><div><strong>{c.locationKey}</strong><small>{isoDay(c.createdAt)} · {c.lines.length} vật tư</small></div><span className={'asset-state '+c.status.toLowerCase()}>{statusLabel[c.status]||c.status}</span>{admin&&c.status==='DRAFT'&&<button onClick={()=>void act(()=>send(`/assets/counts/${c.id}/approve`,{}),'Đã duyệt kiểm kê')}>Duyệt</button>}</div>)}</div></section>}

      {section==='maintenance'&&<section className="asset-panel"><div className="asset-panel-head"><div><h3>Bảo trì / sửa chữa</h3><p>Lịch sử kỹ thuật của tài sản</p></div></div><div className="asset-count-list">{maintenance.map(m=><div key={m.id}><div><strong>{m.asset.code} · {m.asset.name}</strong><small>{m.description} · {isoDay(m.startedAt)}</small></div><span className={'asset-state '+m.status.toLowerCase()}>{statusLabel[m.status]||m.status}</span>{admin&&<span className="asset-inline-money">{cash(m.cost)}</span>}{writable&&m.status==='OPEN'&&<button onClick={()=>void act(()=>send(`/assets/maintenance/${m.id}/complete`,{note:'Hoàn tất trên ứng dụng'}),'Đã hoàn tất bảo trì')}>Hoàn tất</button>}</div>)}</div></section>}

      {section==='history'&&<section className="asset-panel"><div className="asset-panel-head"><div><h3>Lịch sử giao dịch</h3><p>Điều chuyển tài sản và nhập xuất vật tư</p></div></div><div className="asset-history">{history.map(row=><div key={row.type+row.id}><span>{row.type==='ASSET'?'Tài sản':'Vật tư'}</span><div><strong>{row.subject}</strong><p>{row.reason}</p></div><div><b>{row.operation}</b><small>{new Date(row.createdAt).toLocaleString('vi-VN')}</small></div></div>)}</div></section>}
    </>}

    {drawer&&<div className="asset-drawer-backdrop" onMouseDown={e=>{if(e.currentTarget===e.target)setDrawer(null)}}><div className="asset-drawer"><div className="asset-drawer-head"><div><span>Vincent · Tài sản</span><h3>{drawer==='asset'?(editingId?'Sửa tài sản':'Thêm tài sản'):drawer==='move'?'Điều chuyển tài sản':drawer==='rental'?'Bàn giao thiết bị':drawer==='return'?'Thu hồi thiết bị':drawer==='supply'?'Thêm vật tư':drawer==='stock'?'Nhập / xuất kho':drawer==='count'?'Tạo kiểm kê':drawer==='maintenance'?'Ghi nhận bảo trì':'Thanh lý tài sản'}</h3></div><button onClick={()=>setDrawer(null)}><X size={19}/></button></div>
      {drawer==='asset'&&<form onSubmit={saveAsset} className="asset-form"><div className="asset-form-grid"><label>Nhóm tài sản<select value={assetForm.category} onChange={e=>setAssetForm({...assetForm,category:e.target.value})}><option>Tủ lạnh</option><option>Máy giặt</option><option>Bếp từ</option><option>Bàn ghế Sofa</option><option>Bàn ghế</option><option>Đệm</option><option>Khác</option></select></label><label>Tên tài sản<input required value={assetForm.name} onChange={e=>setAssetForm({...assetForm,name:e.target.value})}/></label><label>Hãng<input value={assetForm.brand} onChange={e=>setAssetForm({...assetForm,brand:e.target.value})}/></label><label>Model<input value={assetForm.model} onChange={e=>setAssetForm({...assetForm,model:e.target.value})}/></label><label>Ngày mua<input type="date" value={assetForm.purchaseDate} onChange={e=>setAssetForm({...assetForm,purchaseDate:e.target.value})}/></label>{admin&&<label>Giá trị mua<input type="number" min="0" value={assetForm.purchaseCost} onChange={e=>setAssetForm({...assetForm,purchaseCost:e.target.value})}/></label>}<label>Bảo hành đến<input type="date" value={assetForm.warrantyUntil} onChange={e=>setAssetForm({...assetForm,warrantyUntil:e.target.value})}/></label><label>Tình trạng (%)<input type="number" min="0" max="100" required value={assetForm.conditionPct} onChange={e=>setAssetForm({...assetForm,conditionPct:e.target.value})}/></label></div>{!editingId&&<><label>Loại vị trí<select value={assetForm.locationType} onChange={e=>setAssetForm({...assetForm,locationType:e.target.value})}>{admin&&<option value="CENTRAL">Kho tổng</option>}<option value="BUILDING">Kho tòa nhà</option><option value="ROOM">Phòng</option><option value="COMMON">Khu vực chung</option><option value="REPAIR">Đơn vị sửa chữa</option><option value="OTHER">Khác</option></select></label>{assetForm.locationType!=='CENTRAL'&&<label>Tòa nhà<select required value={assetForm.houseCode} onChange={e=>setAssetForm({...assetForm,houseCode:e.target.value})}><option value="">Chọn tòa nhà</option>{activeHouses.map(h=><option key={h.code} value={h.code}>{h.name||h.code}</option>)}</select></label>}{assetForm.locationType==='ROOM'&&<label>Phòng<input required value={assetForm.room} onChange={e=>setAssetForm({...assetForm,room:e.target.value})}/></label>}</>}<label>Ảnh (URL)<input value={assetForm.imageUrl} onChange={e=>setAssetForm({...assetForm,imageUrl:e.target.value})} placeholder="https://..."/></label><label>Ghi chú<textarea value={assetForm.note} onChange={e=>setAssetForm({...assetForm,note:e.target.value})}/></label><button className="primary" disabled={busy}>{editingId?'Lưu thay đổi':'Tạo tài sản'}</button></form>}
      {drawer==='move'&&selected&&<form className="asset-form" onSubmit={e=>{e.preventDefault();void act(()=>send(`/assets/items/${selected.id}/move`,{...moveForm,houseCode:moveForm.locationType==='CENTRAL'?null:moveForm.houseCode||null,room:moveForm.locationType==='ROOM'?moveForm.room||null:null,expectedVersion:selected.version,requestKey:uuid()}),'Đã điều chuyển tài sản')}}><p className="asset-form-note">{selected.code} · {selected.name}</p><label>Vị trí mới<select value={moveForm.locationType} onChange={e=>setMoveForm({...moveForm,locationType:e.target.value})}>{admin&&<option value="CENTRAL">Kho tổng</option>}<option value="BUILDING">Kho tòa nhà</option><option value="ROOM">Phòng</option><option value="COMMON">Khu vực chung</option><option value="REPAIR">Đơn vị sửa chữa</option><option value="OTHER">Khác</option></select></label>{moveForm.locationType!=='CENTRAL'&&<label>Tòa nhà<select required value={moveForm.houseCode} onChange={e=>setMoveForm({...moveForm,houseCode:e.target.value})}><option value="">Chọn tòa</option>{activeHouses.map(h=><option key={h.code}>{h.code}</option>)}</select></label>}{moveForm.locationType==='ROOM'&&<label>Phòng<input required value={moveForm.room} onChange={e=>setMoveForm({...moveForm,room:e.target.value})}/></label>}<label>Lý do<textarea required value={moveForm.reason} onChange={e=>setMoveForm({...moveForm,reason:e.target.value})}/></label><button className="primary" disabled={busy}>Xác nhận điều chuyển</button></form>}
      {drawer==='rental'&&selected&&<form className="asset-form" onSubmit={e=>{e.preventDefault();void act(()=>send('/assets/rentals',{assetId:selected.id,houseCode:rentalForm.houseCode,room:rentalForm.room,startAt:rentalForm.startAt,expectedEndAt:rentalForm.expectedEndAt||null,monthlyFee:admin?Number(rentalForm.monthlyFee):0,included:rentalForm.included,handoverNote:rentalForm.handoverNote,handoverDoc:null,requestKey:uuid()}),'Đã bàn giao thiết bị')}}><p className="asset-form-note">{selected.code} · {selected.name}</p><label>Tòa nhà<select required value={rentalForm.houseCode} onChange={e=>setRentalForm({...rentalForm,houseCode:e.target.value})}>{activeHouses.map(h=><option key={h.code}>{h.code}</option>)}</select></label><label>Phòng<input required value={rentalForm.room} onChange={e=>setRentalForm({...rentalForm,room:e.target.value})}/></label><div className="asset-form-grid"><label>Ngày bắt đầu<input required type="date" value={rentalForm.startAt} onChange={e=>setRentalForm({...rentalForm,startAt:e.target.value})}/></label><label>Kết thúc dự kiến<input type="date" value={rentalForm.expectedEndAt} onChange={e=>setRentalForm({...rentalForm,expectedEndAt:e.target.value})}/></label></div>{admin&&<label>Giá thuê/tháng<input type="number" min="0" value={rentalForm.monthlyFee} onChange={e=>setRentalForm({...rentalForm,monthlyFee:e.target.value})}/></label>}<label className="asset-check"><input type="checkbox" checked={rentalForm.included} onChange={e=>setRentalForm({...rentalForm,included:e.target.checked})}/> Thiết bị trang bị sẵn, không thu phí riêng</label><label>Ghi chú bàn giao<textarea value={rentalForm.handoverNote} onChange={e=>setRentalForm({...rentalForm,handoverNote:e.target.value})}/></label><button className="primary" disabled={busy}>Bàn giao thiết bị</button></form>}
      {drawer==='return'&&selectedRental&&<form className="asset-form" onSubmit={e=>{e.preventDefault();void act(()=>send(`/assets/rentals/${selectedRental.id}/return`,{endedAt:returnForm.endedAt,note:returnForm.note,to:{locationType:returnForm.locationType,houseCode:returnForm.locationType==='CENTRAL'?null:returnForm.houseCode||null,room:returnForm.locationType==='ROOM'?returnForm.room||null:null},requestKey:uuid()}),'Đã thu hồi thiết bị')}}><p className="asset-form-note">{selectedRental.asset.code} · {selectedRental.houseCode}/P.{selectedRental.room}</p><label>Ngày trả<input required type="date" value={returnForm.endedAt} onChange={e=>setReturnForm({...returnForm,endedAt:e.target.value})}/></label><label>Thu hồi về<select value={returnForm.locationType} onChange={e=>setReturnForm({...returnForm,locationType:e.target.value})}>{admin&&<option value="CENTRAL">Kho tổng</option>}<option value="BUILDING">Kho tòa nhà</option><option value="ROOM">Phòng</option><option value="REPAIR">Đơn vị sửa chữa</option></select></label>{returnForm.locationType!=='CENTRAL'&&<label>Tòa nhà<select value={returnForm.houseCode} onChange={e=>setReturnForm({...returnForm,houseCode:e.target.value})}>{activeHouses.map(h=><option key={h.code}>{h.code}</option>)}</select></label>}{returnForm.locationType==='ROOM'&&<label>Phòng<input value={returnForm.room} onChange={e=>setReturnForm({...returnForm,room:e.target.value})}/></label>}<label>Ghi chú<textarea value={returnForm.note} onChange={e=>setReturnForm({...returnForm,note:e.target.value})}/></label><button className="primary" disabled={busy}>Xác nhận thu hồi</button></form>}
      {drawer==='supply'&&<form className="asset-form" onSubmit={e=>{e.preventDefault();void act(()=>send('/assets/supplies',{...supplyForm,referencePrice:Number(supplyForm.referencePrice),minimumQty:Number(supplyForm.minimumQty)}),'Đã thêm vật tư')}}><div className="asset-form-grid"><label>Mã vật tư<input required value={supplyForm.sku} onChange={e=>setSupplyForm({...supplyForm,sku:e.target.value})}/></label><label>Tên vật tư<input required value={supplyForm.name} onChange={e=>setSupplyForm({...supplyForm,name:e.target.value})}/></label><label>Nhóm<input value={supplyForm.category} onChange={e=>setSupplyForm({...supplyForm,category:e.target.value})}/></label><label>Đơn vị<input value={supplyForm.unit} onChange={e=>setSupplyForm({...supplyForm,unit:e.target.value})}/></label><label>Giá tham khảo<input type="number" min="0" value={supplyForm.referencePrice} onChange={e=>setSupplyForm({...supplyForm,referencePrice:e.target.value})}/></label><label>Tồn tối thiểu<input type="number" min="0" value={supplyForm.minimumQty} onChange={e=>setSupplyForm({...supplyForm,minimumQty:e.target.value})}/></label></div><label>Ghi chú<textarea value={supplyForm.note} onChange={e=>setSupplyForm({...supplyForm,note:e.target.value})}/></label><button className="primary" disabled={busy}>Thêm vật tư</button></form>}
      {drawer==='stock'&&<form className="asset-form" onSubmit={e=>{e.preventDefault();void act(()=>send('/assets/stock/movements',{...stockForm,quantity:Number(stockForm.quantity),fromKey:['IN','RETURN'].includes(stockForm.operation)?null:stockForm.fromKey||null,toKey:stockForm.operation==='OUT'?null:stockForm.toKey||null,workRef:stockForm.workRef||null,requestKey:uuid()}),'Đã ghi nhận nghiệp vụ kho')}}><label>Vật tư<select required value={stockForm.supplyId} onChange={e=>setStockForm({...stockForm,supplyId:e.target.value})}><option value="">Chọn vật tư</option>{supplies.filter(s=>s.active).map(s=><option key={s.id} value={s.id}>{s.sku} · {s.name}</option>)}</select></label><div className="asset-form-grid"><label>Nghiệp vụ<select value={stockForm.operation} onChange={e=>setStockForm({...stockForm,operation:e.target.value})}><option value="IN">Nhập kho</option><option value="OUT">Xuất kho</option><option value="TRANSFER">Chuyển kho</option><option value="RETURN">Trả lại kho</option>{admin&&<option value="ADJUST">Điều chỉnh tồn</option>}</select></label><label>Số lượng<input type="number" required min={stockForm.operation==='ADJUST'?-1000000:1} value={stockForm.quantity} onChange={e=>setStockForm({...stockForm,quantity:e.target.value})}/></label></div>{!['IN','RETURN','ADJUST'].includes(stockForm.operation)&&<label>Kho nguồn<input list="asset-locations" required value={stockForm.fromKey} onChange={e=>setStockForm({...stockForm,fromKey:e.target.value})} placeholder="BUILDING:V4 hoặc ROOM:V4:301"/></label>}{stockForm.operation!=='OUT'&&<label>Kho đích<input list="asset-locations" required value={stockForm.toKey} onChange={e=>setStockForm({...stockForm,toKey:e.target.value})} placeholder="BUILDING:V4 hoặc ROOM:V4:301"/></label>}<datalist id="asset-locations">{locationOptions.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</datalist><label>Lý do<textarea required value={stockForm.reason} onChange={e=>setStockForm({...stockForm,reason:e.target.value})}/></label><label>Mã công việc kỹ thuật<input value={stockForm.workRef} onChange={e=>setStockForm({...stockForm,workRef:e.target.value})}/></label><button className="primary" disabled={busy}>Ghi nhận nghiệp vụ</button></form>}
      {drawer==='count'&&<form className="asset-form" onSubmit={e=>{e.preventDefault();const lines=countRows.map(row=>({supplyId:row.supplyId||supplies.find(s=>s.sku===row.supply.sku)?.id,actualQty:Number(countActuals[row.supply.sku]??row.quantity)})).filter(x=>x.supplyId);void act(()=>send('/assets/counts',{locationKey:countLocation,note:'Kiểm kê từ WebApp Vincent',lines}),'Đã tạo phiếu kiểm kê')}}><label>Vị trí kiểm kê<select required value={countLocation} onChange={e=>{setCountLocation(e.target.value);setCountActuals({})}}><option value="">Chọn kho</option>{locationOptions.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></label><div className="asset-count-form">{countRows.map(row=><label key={row.id}><span>{row.supply.sku} · {row.supply.name}<small>Hệ thống {row.quantity} {row.supply.unit}</small></span><input type="number" min="0" required value={countActuals[row.supply.sku]??String(row.quantity)} onChange={e=>setCountActuals({...countActuals,[row.supply.sku]:e.target.value})}/></label>)}</div>{countLocation&&!countRows.length&&<p className="asset-form-note">Vị trí này chưa có vật tư để kiểm kê.</p>}<button className="primary" disabled={busy||!countRows.length}>Tạo phiếu kiểm kê</button></form>}
      {drawer==='maintenance'&&selected&&<form className="asset-form" onSubmit={e=>{e.preventDefault();void act(()=>send('/assets/maintenance',{assetId:selected.id,kind:maintenanceForm.kind,description:maintenanceForm.description,cost:admin?Number(maintenanceForm.cost):0,note:maintenanceForm.note}),'Đã ghi nhận bảo trì')}}><p className="asset-form-note">{selected.code} · {selected.name}</p><label>Loại công việc<select value={maintenanceForm.kind} onChange={e=>setMaintenanceForm({...maintenanceForm,kind:e.target.value})}><option value="REPAIR">Sửa chữa</option><option value="WARRANTY">Bảo hành</option><option value="MAINTENANCE">Bảo trì</option></select></label><label>Mô tả<textarea required value={maintenanceForm.description} onChange={e=>setMaintenanceForm({...maintenanceForm,description:e.target.value})}/></label>{admin&&<label>Chi phí<input type="number" min="0" value={maintenanceForm.cost} onChange={e=>setMaintenanceForm({...maintenanceForm,cost:e.target.value})}/></label>}<label>Ghi chú<textarea value={maintenanceForm.note} onChange={e=>setMaintenanceForm({...maintenanceForm,note:e.target.value})}/></label><button className="primary" disabled={busy}>Ghi nhận bảo trì</button></form>}
      {drawer==='dispose'&&selected&&<form className="asset-form" onSubmit={e=>{e.preventDefault();void act(()=>send(`/assets/items/${selected.id}/dispose`,{reason:disposeReason,expectedVersion:selected.version}),'Đã thanh lý tài sản')}}><p className="asset-form-note">{selected.code} · {selected.name}. Lịch sử tài sản vẫn được giữ lại.</p><label>Lý do thanh lý<textarea required minLength={3} value={disposeReason} onChange={e=>setDisposeReason(e.target.value)}/></label><button className="danger-btn" disabled={busy}><Trash2 size={15}/> Xác nhận thanh lý</button></form>}
    </div></div>}
  </div>;
}
