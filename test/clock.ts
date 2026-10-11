export function fakeClock() {
	let time = 0;
	let next = 0;
	const timers = new Map<number, { at: number; callback: () => void; interval?: number }>();
	const scheduler = {
		now: () => time,
		wallNow: () => time,
		setTimeout: (callback: () => void, delay: number) => {
			const id = ++next;
			timers.set(id, { at: time + delay, callback });
			return { unref() {}, id } as unknown as ReturnType<typeof setTimeout>;
		},
		setInterval: (callback: () => void, delay: number) => {
			const id = ++next;
			timers.set(id, { at: time + delay, callback, interval: delay });
			return { unref() {}, id } as unknown as ReturnType<typeof setInterval>;
		},
		clearInterval: (timer: ReturnType<typeof setInterval>) => { timers.delete((timer as unknown as { id: number }).id); },
		clearTimeout: (timer: ReturnType<typeof setTimeout>) => { timers.delete((timer as unknown as { id: number }).id); },
	};
	return {
		scheduler,
		count: () => timers.size,
		advance(ms: number) {
			const end = time + ms;
			for (;;) {
				const due = [...timers].filter(([, timer]) => timer.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				time = due[1].at;
				if (due[1].interval !== undefined) due[1].at += due[1].interval;
				else timers.delete(due[0]);
				due[1].callback();
			}
			time = end;
		},
	};
}
