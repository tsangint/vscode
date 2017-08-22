/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import Event, { Emitter } from 'vs/base/common/event';

export enum ScrollbarVisibility {
	Auto = 1,
	Hidden = 2,
	Visible = 3
}

export interface ScrollEvent {
	width: number;
	scrollWidth: number;
	scrollLeft: number;

	height: number;
	scrollHeight: number;
	scrollTop: number;

	widthChanged: boolean;
	scrollWidthChanged: boolean;
	scrollLeftChanged: boolean;

	heightChanged: boolean;
	scrollHeightChanged: boolean;
	scrollTopChanged: boolean;
}

export class ScrollState implements IScrollDimensions, IScrollPosition {
	_scrollStateBrand: void;

	public readonly width: number;
	public readonly scrollWidth: number;
	public readonly scrollLeft: number;
	public readonly height: number;
	public readonly scrollHeight: number;
	public readonly scrollTop: number;

	constructor(
		width: number,
		scrollWidth: number,
		scrollLeft: number,
		height: number,
		scrollHeight: number,
		scrollTop: number
	) {
		width = width | 0;
		scrollWidth = scrollWidth | 0;
		scrollLeft = scrollLeft | 0;
		height = height | 0;
		scrollHeight = scrollHeight | 0;
		scrollTop = scrollTop | 0;

		if (width < 0) {
			width = 0;
		}
		if (scrollLeft + width > scrollWidth) {
			scrollLeft = scrollWidth - width;
		}
		if (scrollLeft < 0) {
			scrollLeft = 0;
		}

		if (height < 0) {
			height = 0;
		}
		if (scrollTop + height > scrollHeight) {
			scrollTop = scrollHeight - height;
		}
		if (scrollTop < 0) {
			scrollTop = 0;
		}

		this.width = width;
		this.scrollWidth = scrollWidth;
		this.scrollLeft = scrollLeft;
		this.height = height;
		this.scrollHeight = scrollHeight;
		this.scrollTop = scrollTop;
	}

	public equals(other: ScrollState): boolean {
		return (
			this.width === other.width
			&& this.scrollWidth === other.scrollWidth
			&& this.scrollLeft === other.scrollLeft
			&& this.height === other.height
			&& this.scrollHeight === other.scrollHeight
			&& this.scrollTop === other.scrollTop
		);
	}

	public withScrollDimensions(update: INewScrollDimensions): ScrollState {
		return new ScrollState(
			(typeof update.width !== 'undefined' ? update.width : this.width),
			(typeof update.scrollWidth !== 'undefined' ? update.scrollWidth : this.scrollWidth),
			this.scrollLeft,
			(typeof update.height !== 'undefined' ? update.height : this.height),
			(typeof update.scrollHeight !== 'undefined' ? update.scrollHeight : this.scrollHeight),
			this.scrollTop
		);
	}

	public withScrollPosition(update: INewScrollPosition): ScrollState {
		return new ScrollState(
			this.width,
			this.scrollWidth,
			(typeof update.scrollLeft !== 'undefined' ? update.scrollLeft : this.scrollLeft),
			this.height,
			this.scrollHeight,
			(typeof update.scrollTop !== 'undefined' ? update.scrollTop : this.scrollTop)
		);
	}

	public createScrollEvent(previous: ScrollState): ScrollEvent {
		let widthChanged = (this.width !== previous.width);
		let scrollWidthChanged = (this.scrollWidth !== previous.scrollWidth);
		let scrollLeftChanged = (this.scrollLeft !== previous.scrollLeft);

		let heightChanged = (this.height !== previous.height);
		let scrollHeightChanged = (this.scrollHeight !== previous.scrollHeight);
		let scrollTopChanged = (this.scrollTop !== previous.scrollTop);

		return {
			width: this.width,
			scrollWidth: this.scrollWidth,
			scrollLeft: this.scrollLeft,

			height: this.height,
			scrollHeight: this.scrollHeight,
			scrollTop: this.scrollTop,

			widthChanged: widthChanged,
			scrollWidthChanged: scrollWidthChanged,
			scrollLeftChanged: scrollLeftChanged,

			heightChanged: heightChanged,
			scrollHeightChanged: scrollHeightChanged,
			scrollTopChanged: scrollTopChanged,
		};
	}

}

export interface IScrollDimensions {
	readonly width: number;
	readonly scrollWidth: number;
	readonly height: number;
	readonly scrollHeight: number;
}
export interface INewScrollDimensions {
	width?: number;
	scrollWidth?: number;
	height?: number;
	scrollHeight?: number;
}

export interface IScrollPosition {
	readonly scrollLeft: number;
	readonly scrollTop: number;
}
export interface INewScrollPosition {
	scrollLeft?: number;
	scrollTop?: number;
}

export class Scrollable extends Disposable {

	_scrollableBrand: void;

	private readonly _smoothScrollDuration: number;
	private readonly _scheduleAtNextAnimationFrame: (callback: () => void) => IDisposable;
	private _state: ScrollState;
	private _smoothScrolling: SmoothScrollingOperation;

	private _onScroll = this._register(new Emitter<ScrollEvent>());
	public onScroll: Event<ScrollEvent> = this._onScroll.event;

	constructor(smoothScrollDuration: number, scheduleAtNextAnimationFrame: (callback: () => void) => IDisposable) {
		super();

		this._smoothScrollDuration = smoothScrollDuration;
		this._scheduleAtNextAnimationFrame = scheduleAtNextAnimationFrame;
		this._state = new ScrollState(0, 0, 0, 0, 0, 0);
		this._smoothScrolling = null;
	}

	public dispose(): void {
		if (this._smoothScrolling) {
			this._smoothScrolling.dispose();
			this._smoothScrolling = null;
		}
		super.dispose();
	}

	public validateScrollPosition(scrollPosition: INewScrollPosition): IScrollPosition {
		return this._state.withScrollPosition(scrollPosition);
	}

	public getScrollDimensions(): IScrollDimensions {
		return this._state;
	}

	public setScrollDimensions(dimensions: INewScrollDimensions): void {
		const newState = this._state.withScrollDimensions(dimensions);
		this._setState(newState);

		// Validate outstanding animated scroll position target
		if (this._smoothScrolling) {
			this._smoothScrolling.acceptScrollDimensions(this._state);
		}
	}

	/**
	 * Returns the final scroll position that the instance will have once the smooth scroll animation concludes.
	 * If no scroll animation is occuring, it will return the current scroll position instead.
	 */
	public getFutureScrollPosition(): IScrollPosition {
		if (this._smoothScrolling) {
			return this._smoothScrolling.to;
		}
		return this._state;
	}

	/**
	 * Returns the current scroll position.
	 * Note: This result might be an intermediate scroll position, as there might be an ongoing smooth scroll animation.
	 */
	public getCurrentScrollPosition(): IScrollPosition {
		return this._state;
	}

	public setScrollPositionNow(update: INewScrollPosition): void {
		// no smooth scrolling requested
		const newState = this._state.withScrollPosition(update);

		// Terminate any outstanding smooth scrolling
		if (this._smoothScrolling) {
			this._smoothScrolling.dispose();
			this._smoothScrolling = null;
		}

		this._setState(newState);
	}

	public setScrollPositionSmooth(update: INewScrollPosition): void {
		if (this._smoothScrollDuration === 0) {
			// Smooth scrolling not supported.
			return this.setScrollPositionNow(update);
		}

		if (this._smoothScrolling) {
			// Combine our pending scrollLeft/scrollTop with incoming scrollLeft/scrollTop
			update = {
				scrollLeft: (typeof update.scrollLeft === 'undefined' ? this._smoothScrolling.to.scrollLeft : update.scrollLeft),
				scrollTop: (typeof update.scrollTop === 'undefined' ? this._smoothScrolling.to.scrollTop : update.scrollTop)
			};

			// Validate `update`
			const validTarget = this._state.withScrollPosition(update);

			if (this._smoothScrolling.to.scrollLeft === validTarget.scrollLeft && this._smoothScrolling.to.scrollTop === validTarget.scrollTop) {
				// No need to interrupt or extend the current animation since we're going to the same place
				return;
			}

			const newSmoothScrolling = this._smoothScrolling.combine(this._state, validTarget, this._smoothScrollDuration);
			this._smoothScrolling.dispose();
			this._smoothScrolling = newSmoothScrolling;
		} else {
			// Validate `update`
			const validTarget = this._state.withScrollPosition(update);

			this._smoothScrolling = SmoothScrollingOperation.start(this._state, validTarget, this._smoothScrollDuration);
		}

		// Begin smooth scrolling animation
		this._smoothScrolling.animationFrameDisposable = this._scheduleAtNextAnimationFrame(() => {
			this._smoothScrolling.animationFrameDisposable = null;
			this._performSmoothScrolling();
		});
	}

	private _performSmoothScrolling(): void {
		const update = this._smoothScrolling.tick();
		const newState = this._state.withScrollPosition(update);

		this._setState(newState);

		if (update.isDone) {
			this._smoothScrolling.dispose();
			this._smoothScrolling = null;
			return;
		}

		// Continue smooth scrolling animation
		this._smoothScrolling.animationFrameDisposable = this._scheduleAtNextAnimationFrame(() => {
			this._smoothScrolling.animationFrameDisposable = null;
			this._performSmoothScrolling();
		});
	}

	private _setState(newState: ScrollState): void {
		const oldState = this._state;
		if (oldState.equals(newState)) {
			// no change
			return;
		}
		this._state = newState;
		this._onScroll.fire(this._state.createScrollEvent(oldState));
	}
}

class SmoothScrollingUpdate implements IScrollPosition {

	public readonly scrollLeft: number;
	public readonly scrollTop: number;
	public readonly isDone: boolean;

	constructor(scrollLeft: number, scrollTop: number, isDone: boolean) {
		this.scrollLeft = scrollLeft;
		this.scrollTop = scrollTop;
		this.isDone = isDone;
	}

}

class SmoothScrollingOperation {

	public readonly from: IScrollPosition;
	public to: IScrollPosition;
	public readonly duration: number;
	private readonly _startTime: number;
	public animationFrameDisposable: IDisposable;

	private constructor(from: IScrollPosition, to: IScrollPosition, startTime: number, duration: number) {
		this.from = from;
		this.to = to;
		this.duration = duration;
		this._startTime = startTime;
		this.animationFrameDisposable = null;
	}

	public dispose(): void {
		if (this.animationFrameDisposable !== null) {
			this.animationFrameDisposable.dispose();
			this.animationFrameDisposable = null;
		}
	}

	public acceptScrollDimensions(state: ScrollState): void {
		this.to = state.withScrollPosition(this.to);
	}

	public tick(): SmoothScrollingUpdate {
		const completion = (Date.now() - this._startTime) / this.duration;

		if (completion < 1) {
			const t = easeOutCubic(completion);
			const newScrollLeft = this.from.scrollLeft + (this.to.scrollLeft - this.from.scrollLeft) * t;
			const newScrollTop = this.from.scrollTop + (this.to.scrollTop - this.from.scrollTop) * t;
			return new SmoothScrollingUpdate(newScrollLeft, newScrollTop, false);
		}

		return new SmoothScrollingUpdate(this.to.scrollLeft, this.to.scrollTop, true);
	}

	public combine(from: IScrollPosition, to: IScrollPosition, duration: number): SmoothScrollingOperation {
		return SmoothScrollingOperation.start(from, to, duration);
	}

	public static start(from: IScrollPosition, to: IScrollPosition, duration: number): SmoothScrollingOperation {
		return new SmoothScrollingOperation(from, to, Date.now(), duration);
	}
}

function easeInCubic(t) {
	return Math.pow(t, 3);
}

function easeOutCubic(t) {
	return 1 - easeInCubic(1 - t);
}
