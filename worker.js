// @ts-ignore
import { connect as 連接 } from 'cloudflare:sockets';

/**
 * ============================================================================
 * Cloudflare Worker 輕量級邊緣代理與動態優選節點生成器（完整修復版）
 * ============================================================================
 */

// ============================ 配置區 ============================

// 認證令牌：請保持與你 v2rayN 相同的 UUID
let 認證令牌 = 'a6708907-1cb5-46ac-8b67-287c53845b67';

// 回退地址：直連失敗時改走的備用地址，留空代表不啟用
let 回退地址 = 'pp.xy.kg';

// 中轉地址：經由 SOCKS5 代理伺服器出站，留空不啟用
let 中轉地址 = '';

// 優選地址（靜態備用）：當 Workers KV 未設定時使用此處，留空預設使用當前 Worker 域名
let 優選地址 = '';

// 家寬鏈式：落地換成網友共享的住宅寬帶（VPN Gate）
let 家寬鏈式 = false;

// ================================================================

const 文本解碼器 = new TextDecoder();

function 解碼64(文本) {
	const 二進位 = atob(文本);
	const 位元組 = new Uint8Array(二進位.length);
	for (let 索引 = 0; 索引 < 二進位.length; 索引++) 位元組[索引] = 二進位.charCodeAt(索引);
	return 文本解碼器.decode(位元組);
}

if (!校驗令牌格式(認證令牌)) {
	throw new Error('令牌格式不合法，請使用標準 UUIDv4 格式');
}

let 中轉配置 = {};
let 啟用中轉 = false;
if (中轉地址) {
	try {
		中轉配置 = 解析中轉地址(中轉地址);
		啟用中轉 = true;
	} catch (err) {
		/** @type {Error} */ let e = err;
		console.log('中轉地址解析失敗: ' + e.toString());
		啟用中轉 = false;
	}
}

export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {any} env 包含 KV 綁定（KV_STORAGE）與環境變數
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env) {
		try {
			const 升級頭 = request.headers.get('Upgrade');

			if (!升級頭 || 升級頭.toLowerCase() !== 'websocket') {
				const 網址 = new URL(request.url);
				switch (網址.pathname) {
					case '/':
						return new Response('hello', { status: 200 });

					case `/${認證令牌}`: {
						const 目標 = (網址.searchParams.get('target') || '').toLowerCase();
						if (目標 === 'vg' || 目標 === 'jk') {
							return await 處理家寬訂閱(認證令牌, request.headers.get('Host'), env);
						}
						const 訂閱內容 = await 生成訂閱配置(認證令牌, request.headers.get('Host'), env);
						return new Response(`${訂閱內容}`, {
							status: 200,
							headers: {
								"Content-Type": "text/plain;charset=utf-8",
							}
						});
					}

					default:
						return new Response('Not found', { status: 404 });
				}
			} else {
				return await 處理套接字升級(request);
			}
		} catch (err) {
			/** @type {Error} */ let e = err;
			return new Response(e.toString(), { status: 500 });
		}
	},
};

async function 處理套接字升級(request) {
	/** @type {import("@cloudflare/workers-types").WebSocket[]} */
	// @ts-ignore
	const 套接字對 = new WebSocketPair();
	const [客戶端, 套接字] = Object.values(套接字對);

	套接字.accept();
	// 【核心修復 1】強制指定 WebSocket 接收二進位緩衝區格式
	套接字.binaryType = 'arraybuffer';

	let 地址 = '';
	let 端口日誌 = '';
	const 記錄 = (/** @type {string} */ 信息, /** @type {string | undefined} */ 事件) => {
		console.log(`[${地址}:${端口日誌}] ${信息}`, 事件 || '');
	};

	const 前置數據頭 = request.headers.get('sec-websocket-protocol') || '';
	const 可讀套接字流 = 創建可讀套接字流(套接字, 前置數據頭, 記錄);

	/** @type {{ value: import("@cloudflare/workers-types").Socket | null}}*/
	let 遠端套接字包裝 = { value: null };
	let 是域名解析 = false;

	可讀套接字流.pipeTo(new WritableStream({
		async write(原始數據塊, controller) {
			// 【核心修復 2】確保數據塊一定是 ArrayBuffer/ArrayBufferView，而非 Blob
			let 數據塊 = 原始數據塊;
			if (數據塊 instanceof Blob) {
				數據塊 = await 數據塊.arrayBuffer();
			}

			if (是域名解析) {
				return await 處理域名解析(數據塊, 套接字, null, 記錄);
			}

			if (遠端套接字包裝.value) {
				const 寫入器 = 遠端套接字包裝.value.writable.getWriter();
				await 寫入器.write(數據塊);
				寫入器.releaseLock();
				return;
			}

			const {
				出錯,
				消息,
				地址類型,
				目標端口 = 443,
				目標地址 = '',
				首包偏移,
				協議版本 = new Uint8Array([0, 0]),
				是數據報,
			} = 解析頭部(數據塊, 認證令牌);

			地址 = 目標地址;
			端口日誌 = `${目標端口}--${Math.random().toFixed(4)} ${是數據報 ? 'udp' : 'tcp'}`;

			if (出錯) {
				throw new Error(消息);
			}

			if (是數據報) {
				if (目標端口 === 53) {
					是域名解析 = true;
				} else {
					throw new Error('當前邊緣節點僅支援 53 通訊埠的 UDP 數據報（DNS 解析）');
				}
			}

			const 響應頭部 = new Uint8Array([協議版本[0], 0]);
			const 客戶端首包 = 數據塊.slice(首包偏移);

			if (是域名解析) {
				return 處理域名解析(客戶端首包, 套接字, 響應頭部, 記錄);
			}

			處理傳輸出站(遠端套接字包裝, 地址類型, 目標地址, 目標端口, 客戶端首包, 套接字, 響應頭部, 記錄);
		},
		close() {
			記錄(`可讀套接字流已關閉`);
		},
		abort(原因) {
			記錄(`可讀套接字流異常中止`, JSON.stringify(原因));
		},
	})).catch((err) => {
		記錄('可讀套接字流 pipeTo 發生異常', err);
	});

	return new Response(null, {
		status: 101,
		// @ts-ignore
		webSocket: 客戶端,
	});
}

async function 處理傳輸出站(遠端套接字, 地址類型, 目標地址, 目標端口, 客戶端首包, 套接字, 響應頭部, 記錄) {
	async function 連接並寫入(地址, 端口, 走中轉 = false) {
		/** @type {import("@cloudflare/workers-types").Socket} */
		const 傳輸套接字 = 走中轉
			? await 中轉連接(地址類型, 地址, 端口, 記錄)
			: 連接({ hostname: 地址, port: 端口 });

		遠端套接字.value = 傳輸套接字;
		記錄(`TCP 已連接至 ${地址}:${端口}`);

		const 寫入器 = 傳輸套接字.writable.getWriter();
		let 首包 = 客戶端首包;
		if (首包 instanceof Blob) {
			首包 = await 首包.arrayBuffer();
		}
		await 寫入器.write(首包);
		寫入器.releaseLock();
		return 傳輸套接字;
	}

	async function 重試() {
		if (啟用中轉) {
			傳輸套接字 = await 連接並寫入(目標地址, 目標端口, true);
		} else {
			傳輸套接字 = await 連接並寫入(回退地址 || 目標地址, 目標端口);
		}
		傳輸套接字.closed.catch(錯誤 => {
			console.log('重試連線關閉異常', 錯誤);
		}).finally(() => {
			安全關閉套接字(套接字);
		});
		遠端回傳套接字(傳輸套接字, 套接字, 響應頭部, null, 記錄);
	}

	let 傳輸套接字 = await 連接並寫入(目標地址, 目標端口);
	遠端回傳套接字(傳輸套接字, 套接字, 響應頭部, 重試, 記錄);
}

function 創建可讀套接字流(套接字服務端, 前置數據頭, 記錄) {
	let 已取消 = false;
	// 【核心修復 3】確保服務端套接字接收 ArrayBuffer
	套接字服務端.binaryType = 'arraybuffer';

	const 流 = new ReadableStream({
		start(controller) {
			套接字服務端.addEventListener('message', async (事件) => {
				if (已取消) return;
				let 數據 = 事件.data;
				if (數據 instanceof Blob) {
					數據 = await 數據.arrayBuffer();
				}
				controller.enqueue(數據);
			});

			套接字服務端.addEventListener('close', () => {
				安全關閉套接字(套接字服務端);
				if (已取消) return;
				controller.close();
			});

			套接字服務端.addEventListener('error', (err) => {
				記錄('WebSocket 服務端觸發錯誤');
				controller.error(err);
			});

			const { 前置數據, error } = 六四轉字節緩衝(前置數據頭);
			if (error) {
				controller.error(error);
			} else if (前置數據) {
				controller.enqueue(前置數據);
			}
		},

		cancel(原因) {
			if (已取消) return;
			記錄(`可讀流被取消，原因：${原因}`);
			已取消 = true;
			安全關閉套接字(套接字服務端);
		}
	});

	return 流;
}

function 解析頭部(數據緩衝, 認證令牌) {
	if (數據緩衝.byteLength < 24) {
		return { 出錯: true, 消息: '數據包長度過短，不符合 VLESS 規範' };
	}

	const 版本 = new Uint8Array(數據緩衝.slice(0, 1));
	let 令牌有效 = false;
	if (字節轉文本(new Uint8Array(數據緩衝.slice(1, 17))) === 認證令牌) {
		令牌有效 = true;
	}
	if (!令牌有效) {
		return { 出錯: true, 消息: 'UUID 認證失敗，憑證不匹配' };
	}

	const 附加長度 = new Uint8Array(數據緩衝.slice(17, 18))[0];
	const 命令 = new Uint8Array(數據緩衝.slice(18 + 附加長度, 18 + 附加長度 + 1))[0];

	let 是數據報 = false;
	if (命令 === 1) {
		是數據報 = false;
	} else if (命令 === 2) {
		是數據報 = true;
	} else {
		return { 出錯: true, 消息: `不支援的指令代碼: ${命令}，僅支援 01(TCP) / 02(UDP)` };
	}

	const 端口偏移 = 18 + 附加長度 + 1;
	const 端口緩衝 = 數據緩衝.slice(端口偏移, 端口偏移 + 2);
	const 目標端口 = new DataView(端口緩衝).getUint16(0);

	let 地址偏移 = 端口偏移 + 2;
	const 地址緩衝 = new Uint8Array(數據緩衝.slice(地址偏移, 地址偏移 + 1));
	const 地址類型 = 地址緩衝[0];

	let 地址長度 = 0;
	let 地址值偏移 = 地址偏移 + 1;
	let 目標地址 = '';

	switch (地址類型) {
		case 1:
			地址長度 = 4;
			目標地址 = new Uint8Array(數據緩衝.slice(地址值偏移, 地址值偏移 + 地址長度)).join('.');
			break;
		case 2:
			地址長度 = new Uint8Array(數據緩衝.slice(地址值偏移, 地址值偏移 + 1))[0];
			地址值偏移 += 1;
			目標地址 = new TextDecoder().decode(數據緩衝.slice(地址值偏移, 地址值偏移 + 地址長度));
			break;
		case 3:
			地址長度 = 16;
			const 數據視圖 = new DataView(數據緩衝.slice(地址值偏移, 地址值偏移 + 地址長度));
			const 六段地址 = [];
			for (let 索引 = 0; 索引 < 8; 索引++) {
				六段地址.push(數據視圖.getUint16(索引 * 2).toString(16));
			}
			目標地址 = 六段地址.join(':');
			break;
		default:
			return { 出錯: true, 消息: `不合法的地址類型: ${地址類型}` };
	}

	if (!目標地址) {
		return { 出錯: true, 消息: '目標地址為空' };
	}

	return {
		出錯: false,
		目標地址,
		地址類型,
		目標端口,
		首包偏移: 地址值偏移 + 地址長度,
		協議版本: 版本,
		是數據報,
	};
}

async function 遠端回傳套接字(遠端套接字, 套接字, 響應頭部, 重試, 記錄) {
	/** @type {ArrayBuffer | null} */
	let 頭部 = 響應頭部;
	let 有回傳數據 = false;

	await 遠端套接字.readable
		.pipeTo(
			new WritableStream({
				async write(數據塊, controller) {
					有回傳數據 = true;
					if (套接字.readyState !== 套接字狀態_打開) {
						controller.error('WebSocket 已關閉，終止轉發');
					}
					if (頭部) {
						套接字.send(await new Blob([頭部, 數據塊]).arrayBuffer());
						頭部 = null;
					} else {
						套接字.send(數據塊);
					}
				},
				close() {
					記錄(`遠端連線讀取流已關閉，是否有回傳數據: ${有回傳數據}`);
				},
				abort(原因) {
					console.error(`遠端連線異常中止`, 原因);
				},
			})
		)
		.catch((錯誤) => {
			console.error(`遠端回傳套接字管道異常:`, 錯誤.stack || 錯誤);
			安全關閉套接字(套接字);
		});

	if (有回傳數據 === false && 重試) {
		記錄(`未收到遠端回傳數據，觸發容災回退`);
		重試();
	}
}

function 六四轉字節緩衝(文本) {
	if (!文本) return { error: null };
	try {
		文本 = 文本.replace(/-/g, '+').replace(/_/g, '/');
		const 解碼 = atob(文本);
		const 字節緩衝 = Uint8Array.from(解碼, (字符) => 字符.charCodeAt(0));
		return { 前置數據: 字節緩衝.buffer, error: null };
	} catch (error) {
		return { error };
	}
}

function 校驗令牌格式(令牌) {
	const 令牌正則 = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return 令牌正則.test(令牌);
}

const 套接字狀態_打開 = 1;
const 套接字狀態_關閉中 = 2;

function 安全關閉套接字(套接字) {
	try {
		if (套接字.readyState === 套接字狀態_打開 || 套接字.readyState === 套接字狀態_關閉中) {
			套接字.close();
		}
	} catch (error) {
		console.error('安全關閉 WebSocket 時發生異常', error);
	}
}

const 字節十六進制表 = [];
for (let 索引 = 0; 索引 < 256; ++索引) {
	字節十六進制表.push((索引 + 256).toString(16).slice(1));
}

function 字節轉文本(字節數組, 偏移 = 0) {
	const 令牌 = (
		字節十六進制表[字節數組[偏移 + 0]] + 字節十六進制表[字節數組[偏移 + 1]] +
		字節十六進制表[字節數組[偏移 + 2]] + 字節十六進制表[字節數組[偏移 + 3]] + "-" +
		字節十六進制表[字節數組[偏移 + 4]] + 字節十六進制表[字節數組[偏移 + 5]] + "-" +
		字節十六進制表[字節數組[偏移 + 6]] + 字節十六進制表[字節數組[偏移 + 7]] + "-" +
		字節十六進制表[字節數組[偏移 + 8]] + 字節十六進制表[字節數組[偏移 + 9]] + "-" +
		字節十六進制表[字節數組[偏移 + 10]] + 字節十六進制表[字節數組[偏移 + 11]] +
		字節十六進制表[字節數組[偏移 + 12]] + 字節十六進制表[字節數組[偏移 + 13]] +
		字節十六進制表[字節數組[偏移 + 14]] + 字節十六進制表[字節數組[偏移 + 15]]
	).toLowerCase();

	if (!校驗令牌格式(令牌)) {
		throw TypeError("還原出的 UUID 格式不合法");
	}
	return 令牌;
}

async function 處理域名解析(報文數據, 套接字, 響應頭部, 記錄) {
	try {
		const 解析服務器 = '8.8.4.4';
		const 解析端口 = 53;
		/** @type {ArrayBuffer | null} */
		let 頭部 = 響應頭部;
		const 傳輸套接字 = 連接({ hostname: 解析服務器, port: 解析端口 });

		記錄(`DNS 查詢已轉發至 ${解析服務器}:${解析端口}`);
		const 寫入器 = 傳輸套接字.writable.getWriter();
		let 數據 = 報文數據;
		if (數據 instanceof Blob) {
			數據 = await 數據.arrayBuffer();
		}
		await 寫入器.write(數據);
		寫入器.releaseLock();

		await 傳輸套接字.readable.pipeTo(new WritableStream({
			async write(數據塊) {
				if (套接字.readyState === 套接字狀態_打開) {
					if (頭部) {
						套接字.send(await new Blob([頭部, 數據塊]).arrayBuffer());
						頭部 = null;
					} else {
						套接字.send(數據塊);
					}
				}
			},
			close() {
				記錄(`DNS 解析連線已關閉`);
			},
			abort(原因) {
				console.error(`DNS 解析連線異常中止`, 原因);
			},
		}));
	} catch (錯誤) {
		console.error(`處理 DNS 域名解析異常: ${錯誤.message}`);
	}
}

async function 中轉連接(地址類型, 目標地址, 目標端口, 記錄) {
	const { 用戶名, 密碼, 主機名, 端口 } = 中轉配置;
	const 套接字 = 連接({ hostname: 主機名, port: 端口 });

	const 握手問候 = new Uint8Array([5, 2, 0, 2]);
	const 寫入器 = 套接字.writable.getWriter();
	await 寫入器.write(握手問候);
	記錄('已發送 SOCKS5 握手問候');

	const 讀取器 = 套接字.readable.getReader();
	const 編碼器 = new TextEncoder();
	let 響應 = (await 讀取器.read()).value;

	if (響應[0] !== 0x05) {
		記錄(`SOCKS5 服務端版本不符合: ${響應[0]}`);
		return;
	}
	if (響應[1] === 0xff) {
		記錄("SOCKS5 服務端無可接受的認證方式");
		return;
	}

	if (響應[1] === 0x02) {
		if (!用戶名 || !密碼) {
			記錄("SOCKS5 伺服器要求認證，但未提供帳號密碼");
			return;
		}
		const 認證請求 = new Uint8Array([
			1,
			用戶名.length, ...編碼器.encode(用戶名),
			密碼.length, ...編碼器.encode(密碼)
		]);
		await 寫入器.write(認證請求);
		響應 = (await 讀取器.read()).value;
		if (響應[0] !== 0x01 || 響應[1] !== 0x00) {
			記錄("SOCKS5 帳號密碼認證失敗");
			return;
		}
	}

	let 目標地址報文;
	switch (地址類型) {
		case 1:
			目標地址報文 = new Uint8Array([1, ...目標地址.split('.').map(Number)]);
			break;
		case 2:
			目標地址報文 = new Uint8Array([3, 目標地址.length, ...編碼器.encode(目標地址)]);
			break;
		case 3:
			目標地址報文 = new Uint8Array([
				4, ...目標地址.split(':').flatMap(段 => [parseInt(段.slice(0, 2), 16), parseInt(段.slice(2), 16)])
			]);
			break;
		default:
			記錄(`無效的地址類型: ${地址類型}`);
			return;
	}

	const 連接請求 = new Uint8Array([5, 1, 0, ...目標地址報文, 目標端口 >> 8, 目標端口 & 0xff]);
	await 寫入器.write(連接請求);
	記錄('已發送 SOCKS5 CONNECT 連線請求');

	響應 = (await 讀取器.read()).value;
	if (響應[1] === 0x00) {
		記錄("SOCKS5 轉發通道已成功建立");
	} else {
		記錄(`SOCKS5 連線建立失敗，伺服器應答碼: ${響應[1]}`);
		return;
	}

	寫入器.releaseLock();
	讀取器.releaseLock();
	return 套接字;
}

function 解析中轉地址(地址) {
	let [後段, 前段] = 地址.split("@").reverse();
	let 用戶名, 密碼, 主機名, 端口;
	if (前段) {
		const 前段列表 = 前段.split(":");
		if (前段列表.length !== 2) throw new Error('中轉地址格式不合法');
		[用戶名, 密碼] = 前段列表;
	}
	const 後段列表 = 後段.split(":");
	端口 = Number(後段列表.pop());
	if (isNaN(端口)) throw new Error('中轉地址格式不合法');
	主機名 = 後段列表.join(":");
	const 正則 = /^\[.*\]$/;
	if (主機名.includes(":") && !正則.test(主機名)) throw new Error('中轉地址格式不合法');
	return { 用戶名, 密碼, 主機名, 端口 };
}

async function 收集優選地址(主機名, env) {
	const 結果 = [];
	const 已見 = new Set();
	const 加入 = (原始) => {
		const 文本 = (原始 || '').trim();
		if (!文本) return;
		const 井號分割 = 文本.split('#');
		const 備註 = 井號分割.length > 1 ? 井號分割.slice(1).join('#').trim() : '';
		const 地址端口 = 井號分割[0].trim();
		if (!地址端口) return;
		let 地址, 端口;
		const 六 = 地址端口.match(/^\[(.+)\]:(\d+)$/);
		if (六) {
			地址 = 六[1]; 端口 = 六[2];
		} else if (地址端口.includes(':') && 地址端口.split(':').length === 2) {
			[地址, 端口] = 地址端口.split(':');
		} else {
			地址 = 地址端口; 端口 = '443';
		}
		地址 = (地址 || '').trim();
		端口 = (端口 || '443').trim();
		if (!地址) return;
		const 鍵 = `${地址}:${端口}`;
		if (已見.has(鍵)) return;
		已見.add(鍵);
		結果.push({ 地址, 端口, 備註: 備註 || 鍵 });
	};

	let 實際優選 = 優選地址;
	if (env && env.KV_STORAGE) {
		try {
			const kv內容 = await env.KV_STORAGE.get('PREFERRED_ADDR');
			if (kv內容 && kv內容.trim()) {
				實際優選 = kv內容.trim();
			}
		} catch (e) {
			console.error('從 KV_STORAGE 讀取優選地址異常，改用預設配置:', e);
		}
	}

	const 配置項列表 = (實際優選 || '').split(/[\n,，]/).map((項) => 項.trim()).filter(Boolean);
	for (const 配置項 of 配置項列表) {
		if (/^https?:\/\//i.test(配置項)) {
			try {
				const 響應 = await fetch(配置項, { cf: { cacheTtl: 300 } });
				if (響應.ok) {
					const 正文 = await 響應.text();
					for (const 行 of 正文.split('\n')) 加入(行);
				}
			} catch (err) {
			}
		} else {
			加入(配置項);
		}
	}

	if (結果.length === 0 && 主機名) 加入(主機名);
	return 結果;
}

const 明文端口列表 = [80, 8080, 8880, 2052, 2082, 2086, 2095];

async function 生成訂閱配置(認證令牌, 主機名, env) {
	const 協議 = 解碼64('dmxlc3M=');
	const 域名 = 主機名 || '';
	const 地址列表 = await 收集優選地址(域名, env);
	const 鏈接列表 = 地址列表.map((項) => {
		const 安全地址 = 項.地址.includes(':') ? `[${項.地址}]` : 項.地址;
		const 是明文 = 明文端口列表.includes(Number(項.端口));
		const 安全參數 = 是明文 ? 'security=none' : `security=tls&sni=${域名}&fp=chrome`;
		return `${協議}://${認證令牌}@${安全地址}:${項.端口}` +
			`?encryption=none&${安全參數}&type=ws&host=${域名}&path=%2F%3Fed%3D2048` +
			`#${encodeURIComponent(項.備註)}`;
	});
	return btoa(鏈接列表.join('\n'));
}

const 家寬節點源 = 解碼64('aHR0cHM6Ly93d3cudnBuZ2F0ZS5uZXQvYXBpL2lwaG9uZS8=');
const 家寬節點類型 = 解碼64('b3BlbnZwbg==');
const 家寬前置字段 = 解碼64('ZGlhbGVyLXByb3h5');
const 家寬機房前綴 = 解碼64('cHVibGljLXZwbg==');
const 家寬機房網段 = '219.100.37.';
const 家寬緩存期限 = 30 * 60 * 1000;
let 家寬緩存 = null;
let 家寬緩存時間 = 0;
const 家寬指令正則 = {};

function 引號(值) {
	return JSON.stringify(String(值 == null ? '' : 值));
}

function 取家寬指令(配置文本, 指令名) {
	if (!家寬指令正則[指令名]) 家寬指令正則[指令名] = new RegExp('^[ \\t]*' + 指令名 + '[ \\t]+(.+?)[ \\t]*$', 'm');
	const 命中 = 配置文本.match(家寬指令正則[指令名]);
	return 命中 ? 命中[1].trim() : '';
}

function 取家寬內聯塊(配置文本, 標籤) {
	const 命中 = 配置文本.match(new RegExp('<' + 標籤 + '>([\\s\\S]*?)<\\/' + 標籤 + '>'));
	return 命中 ? 命中[1].trim() : '';
}

function 縮進證書文本(文本, 空白) {
	return 文本.split('\n').map((行) => 行.trim()).filter(Boolean).map((行) => 空白 + 行).join('\n');
}

const 家寬前段長度 = 6000;
function 解家寬配置(配置64, 整條 = false) {
	const 乾淨 = 配置64.replace(/\s/g, '');
	if (整條 || 乾淨.length <= 家寬前段長度) return 解碼64(乾淨);
	return 解碼64(乾淨.slice(0, 家寬前段長度));
}

function 解析家寬清單(原文) {
	const 候選 = [];
	for (const 原始行 of 原文.split('\n')) {
		const 行 = 原始行.trim();
		if (!行 || 行.charAt(0) === '*' || 行.charAt(0) === '#') continue;
		const 字段 = 行.split(',');
		if (字段.length < 15) continue;
		if ((字段[0] || '').indexOf(家寬機房前綴) === 0) continue;
		if ((字段[1] || '').indexOf(家寬機房網段) === 0) continue;
		const 配置64 = 字段[字段.length - 1];
		if (!配置64 || 配置64.length < 100) continue;
		候選.push({ 國家: (字段[6] || '').toUpperCase() || 'XX', 速度: parseInt(字段[4], 10) || 0, 配置64 });
	}

	候選.sort((甲, 乙) => 乙.速度 - 甲.速度);
	const 節點列表 = [];
	let 證書 = null;

	for (const 項 of 候選) {
		let 配置文本 = '';
		try {
			配置文本 = 解家寬配置(項.配置64);
			if (!取家寬指令(配置文本, 'remote')) 配置文本 = 解家寬配置(項.配置64, true);
		} catch (err) {
			continue;
		}

		if ((取家寬指令(配置文本, 'proto') || 'tcp').toLowerCase() !== 'tcp') continue;
		const 遠端 = 取家寬指令(配置文本, 'remote').split(/\s+/);
		if (!遠端[0]) continue;

		if (!證書) {
			try {
				const 全文 = 解家寬配置(項.配置64, true);
				const 本次證書 = { ca: 取家寬內聯塊(全文, 'ca'), cert: 取家寬內聯塊(全文, 'cert'), key: 取家寬內聯塊(全文, 'key') };
				if (本次證書.ca && 本次證書.cert && 本次證書.key) 證書 = 本次證書;
			} catch (err) {}
			if (!證書) continue;
		}

		節點列表.push({
			國家: 項.國家,
			地址: 遠端[0],
			端口: parseInt(遠端[1], 10) || 443,
			加密: 取家寬指令(配置文本, 'cipher') || 'AES-128-CBC',
			摘要: 取家寬指令(配置文本, 'auth') || 'SHA1',
		});
	}
	return { 節點列表, 證書 };
}

async function 獲取家寬節點() {
	const 現在 = Date.now();
	if (家寬緩存 && 現在 - 家寬緩存時間 < 家寬緩存期限) return 家寬緩存;

	let 原文 = '';
	let 最後錯誤 = null;
	for (const 源 of [家寬節點源, 家寬節點源.replace(/^https:/, 'http:')]) {
		try {
			const 響應 = await fetch(源, {
				headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/plain' },
				cf: { cacheTtl: 1800, cacheEverything: true },
			});
			if (!響應.ok) {
				最後錯誤 = new Error('節點源回傳 ' + 響應.status);
				continue;
			}
			原文 = await 響應.text();
			break;
		} catch (err) {
			最後錯誤 = err;
		}
	}

	if (!原文) throw 最後錯誤 || new Error('未能取得節點源內容');
	const 結果 = 解析家寬清單(原文);
	if (!結果.節點列表.length || !結果.證書) throw new Error('未能解析出可用的家寬節點');

	家寬緩存 = 結果;
	家寬緩存時間 = 現在;
	return 結果;
}

function 生成家寬前置(認證令牌, 域名, 地址列表) {
	const 全部 = 地址列表.map((項) => ({ ...項, 走加密: !明文端口列表.includes(Number(項.端口)) }));
	const 加密的 = 全部.filter((項) => 項.走加密);
	const 選用 = 加密的.length ? 加密的 : 全部;
	const 已用名 = new Set();

	return 選用.map((項) => {
		const 基礎名 = 項.備註 || `${項.地址}:${項.端口}`;
		let 名稱 = 基礎名;
		for (let 序號 = 2; 已用名.has(名稱); 序號++) 名稱 = `${基礎名} ${序號}`;
		已用名.add(名稱);

		const 行 = [
			`  - name: ${引號(名稱)}`,
			`    type: ${解碼64('dmxlc3M=')}`,
			`    server: ${引號(項.地址)}`,
			`    port: ${Number(項.端口) || 443}`,
			`    uuid: ${認證令牌}`,
			'    udp: true',
			`    tls: ${項.走加密 ? 'true' : 'false'}`,
			'    client-fingerprint: chrome',
		];
		if (項.走加密) 行.push(`    servername: ${引號(域名)}`, '    skip-cert-verify: false');
		行.push('    network: ws', '    ws-opts:', '      path: "/?ed=2048"', '      headers:', `        Host: ${引號(域名)}`);
		return { 名稱, 文本: 行.join('\n') };
	});
}

async function 生成家寬訂閱(認證令牌, 主機名, env) {
	const 前置組名 = '\u26a1 CF前置';
	const 家寬自動 = '\ud83c\udfe0 家寬自動';
	const 家寬手選 = '\ud83c\udfe0 家寬節點';
	const 節點選擇 = '\ud83d\ude80 節點選擇';
	const 域名 = 主機名 || '';
	const 前置 = 生成家寬前置(認證令牌, 域名, await 收集優選地址(域名, env));
	const 前置名稱 = 前置.map((項) => 項.名稱);
	const { 節點列表, 證書 } = await 獲取家寬節點();

	const 國家計數 = {};
	const 家寬項 = 節點列表.map((節點) => {
		國家計數[節點.國家] = (國家計數[節點.國家] || 0) + 1;
		return { ...節點, 名稱: '\ud83c\udfe0 ' + 節點.國家 + '-家寬-' + String(國家計數[節點.國家]).padStart(2, '0') };
	});

	const 頭部 = [
		'# 家寬鏈式訂閱：前置走 Cloudflare 邊緣，落地為住宅寬帶',
		'# 核心需求：Mihomo (Clash Meta) 內核 1.19.25 以上',
		'mixed-port: 7890',
		'allow-lan: false',
		'mode: rule',
		'log-level: info',
		'ipv6: false',
		'unified-delay: true',
		'tcp-concurrent: true',
		'dns:',
		'  enable: true',
		'  ipv6: false',
		'  enhanced-mode: fake-ip',
		'  fake-ip-range: 198.18.0.1/16',
		'  nameserver:',
		'    - https://223.5.5.5/dns-query',
		'    - https://1.1.1.1/dns-query',
		'',
	];

	const 節點段 = ['proxies:'];
	for (const 項 of 前置) 節點段.push(項.文本);

	家寬項.forEach((節點, 下標) => {
		const 行 = [
			`  - name: ${引號(節點.名稱)}`,
			`    type: ${家寬節點類型}`,
			`    server: ${節點.地址}`,
			`    port: ${節點.端口}`,
			'    proto: tcp',
			'    username: vpn',
			'    password: vpn',
			`    cipher: ${節點.加密}`,
			`    auth: ${節點.摘要}`,
			'    udp: false',
			'    handshake-timeout: 30',
			'    remote-dns-resolve: true',
			'    dns: [ 8.8.8.8, 1.1.1.1 ]',
		];
		if (前置名稱.length) 行.push(`    ${家寬前置字段}: ${引號(前置組名)}`);

		if (下標 === 0) {
			行.push('    ca: &jkca |-', 縮進證書文本(證書.ca, '      '));
			行.push('    cert: &jkcert |-', 縮進證書文本(證書.cert, '      '));
			行.push('    key: &jkkey |-', 縮進證書文本(證書.key, '      '));
		} else {
			行.push('    ca: *jkca', '    cert: *jkcert', '    key: *jkkey');
		}
		節點段.push(行.join('\n'));
	});

	const 列出 = (名稱列表) => 名稱列表.map((名稱) => `      - ${引號(名稱)}`).join('\n');
	const 按速度 = 家寬項.map((項) => 項.名稱);
	const 按國家 = 家寬項.slice().sort((甲, 乙) => (甲.國家 === 乙.國家 ? 0 : 甲.國家 < 乙.國家 ? -1 : 1)).map((項) => 項.名稱);

	const 分組段 = [解碼64('cHJveHktZ3JvdXBzOg==')];
	if (前置名稱.length) {
		分組段.push(`  - name: ${引號(前置組名)}`, '    type: url-test',
			'    url: https://www.gstatic.com/generate_204', '    interval: 300', '    tolerance: 50',
			'    proxies:', 列出(前置名稱));
	}

	分組段.push(`  - name: ${引號(家寬自動)}`, '    type: fallback',
		'    url: https://www.gstatic.com/generate_204', '    interval: 1800', '    lazy: true',
		'    proxies:', 列出(按速度));

	分組段.push(`  - name: ${引號(家寬手選)}`, '    type: select', '    proxies:', 列出(按國家));

	const 主選 = [家寬自動, 家寬手選].concat(前置名稱.length ? [前置組名] : []);
	分組段.push(`  - name: ${引號(節點選擇)}`, '    type: select', '    proxies:', 列出(主選) + '\n      - DIRECT');

	const 規則段 = [
		'rules:',
		'  - GEOIP,LAN,DIRECT,no-resolve',
		'  - GEOIP,CN,DIRECT,no-resolve',
		`  - MATCH,${節點選擇}`,
	];

	return 頭部.concat(節點段, [''], 分組段, [''], 規則段, ['']).join('\n');
}

async function 處理家寬訂閱(認證令牌, 主機名, env) {
	const 純文本頭 = { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store' };
	if (!家寬鏈式) {
		return new Response('家寬鏈式功能未啟用。請將配置區的「家寬鏈式」設定為 true 後重新儲存部署。', { status: 403, headers: 純文本頭 });
	}
	try {
		const 內容 = await 生成家寬訂閱(認證令牌, 主機名, env);
		return new Response(內容, {
			status: 200,
			headers: { 'Content-Type': 'text/yaml;charset=utf-8', 'Cache-Control': 'no-store' },
		});
	} catch (err) {
		const 原因 = err && err.message ? err.message : String(err);
		return new Response(`家寬節點暫時無法拉取：${原因}\n請稍候重試，客戶端將保留並使用上一份快取配置。`, { status: 503, headers: 純文本頭 });
	}
}
