// The below copyright notice and the license permission notice
// shall be included in all copies or substantial portions.
// Copyright (C) 2019-2021 Yury Chetyrko <ychetyrko@gmail.com>
// MIT License: https://raw.githubusercontent.com/nezaboodka/reactronic-front/master/LICENSE
// By contributing, you agree that your contributions will be
// automatically licensed under the license referred above.

import { options, Reentrance, TraceLevel, transaction } from 'reactronic'
import { extractPointerButton, PointerButton, PointerSensor } from './PointerSensor'
import { SymDataForSensor } from './HtmlApiExt'
import { DataForSensor, EmptyDataArray, grabElementData } from './DataForSensor'
import { extractModifierKeys, KeyboardModifiers } from './KeyboardSensor'
import { WindowSensor } from './WindowSensor'

export enum ButtonState {
  Pressed,
  Selecting,
  Selected,
  Released,
}

export class ButtonSensor extends PointerSensor {
  state: ButtonState
  originData: unknown
  selectedData: unknown
  pointerButton: PointerButton
  selectedX: number // position relative to browser's viewport
  selectedY: number // position relative to browser's viewport
  selected: boolean

  constructor(window: WindowSensor) {
    super(window)
    this.state = ButtonState.Released
    this.originData = undefined
    this.selectedData = undefined
    this.pointerButton = PointerButton.None
    this.selectedX = Infinity
    this.selectedY = Infinity
    this.selected = false
  }

  @transaction
  listen(element: HTMLElement | undefined, enabled: boolean = true): void {
    const existing = this.sourceElement
    if (element !== existing) {
      if (existing) {
        existing.removeEventListener('pointermove', this.onPointerMove.bind(this), { capture: true })
        existing.removeEventListener('pointerdown', this.onPointerDown.bind(this), { capture: true })
        existing.removeEventListener('pointerup', this.onPointerUp.bind(this), { capture: true })
        existing.removeEventListener('lostpointercapture', this.onLostPointerCapture.bind(this), { capture: true })
        existing.removeEventListener('keydown', this.onKeyDown.bind(this), { capture: true })
      }
      this.sourceElement = element
      if (element && enabled) {
        element.addEventListener('pointermove', this.onPointerMove.bind(this), { capture: true })
        element.addEventListener('pointerdown', this.onPointerDown.bind(this), { capture: true })
        element.addEventListener('pointerup', this.onPointerUp.bind(this), { capture: true })
        element.addEventListener('lostpointercapture', this.onLostPointerCapture.bind(this), { capture: true })
        element.addEventListener('keydown', this.onKeyDown.bind(this), { capture: true })
      }
    }
  }

  @transaction
  reset(): void {
    this.doReset()
  }

  protected onPointerDown(e: PointerEvent): void {
    if (this.state === ButtonState.Released && (e.button === 0 || e.button === 1))
      this.press(e)
    this.setPreventDefaultAndStopPropagation(e)
  }

  protected onPointerMove(e: PointerEvent): void {
    if (this.state === ButtonState.Pressed || this.state === ButtonState.Selecting)
      this.selecting(e)
    this.setPreventDefaultAndStopPropagation(e)
  }

  protected onPointerUp(e: PointerEvent): void {
    if (this.state === ButtonState.Selecting) {
      this.select(e)
      this.release()
    }
    else if (this.state === ButtonState.Pressed) {
      this.release()
    }
    this.setPreventDefaultAndStopPropagation(e)
    this.reset()
  }

  protected onLostPointerCapture(e: PointerEvent): void {
    if (this.state !== ButtonState.Released) {
      this.cancel()
      this.reset()
    }
  }

  protected onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.state !== ButtonState.Released) {
      this.cancel()
      this.reset()
    }
  }

  @transaction @options({ trace: TraceLevel.Suppress })
  protected press(e: PointerEvent): void {
    this.preventDefault = false
    this.stopPropagation = false
    const elements = document.elementsFromPoint(e.clientX, e.clientY)
    const { data: elementDataUnderPointer, window } = grabElementData(elements, SymDataForSensor, 'button', EmptyDataArray)
    const originData = elementDataUnderPointer[0] as DataForSensor | undefined
    if (originData) {
      this.state = ButtonState.Pressed
      this.pointerButton = extractPointerButton(e)
      this.elementDataUnderPointer = elementDataUnderPointer
      this.originData = originData
      const path = e.composedPath()
      const { data: elementData } = grabElementData(path, SymDataForSensor, 'button', EmptyDataArray)
      this.elementDataList = elementData
      this.modifiers = extractModifierKeys(e)
      this.positionX = e.clientX
      this.positionY = e.clientY
      this.revision++
    }
    this.window?.setActiveWindow(window)
  }

  @transaction @options({ reentrance: Reentrance.CancelPrevious, trace: TraceLevel.Suppress })
  protected selecting(e: PointerEvent): void {
    this.updateSensorData(e)
    this.state = ButtonState.Selecting
    this.selected = false
  }

  @transaction @options({ trace: TraceLevel.Suppress })
  protected select(e: PointerEvent): void {
    this.updateSensorData(e)
    this.state = ButtonState.Selected
    this.selectedX = e.clientX
    this.selectedY = e.clientY
    this.selected = true
  }

  @transaction @options({ trace: TraceLevel.Suppress })
  protected release(): void {
    this.preventDefault = false
    this.stopPropagation = false
    this.state = ButtonState.Released
    this.revision++
  }

  @transaction @options({ trace: TraceLevel.Suppress })
  protected cancel(): void {
    this.state = ButtonState.Released
    this.selected = false
    this.revision++
  }

  protected doReset(): void {
    this.preventDefault = false
    this.stopPropagation = false
    this.elementDataList = EmptyDataArray
    this.originData = undefined
    this.selectedData = undefined
    this.pointerButton = PointerButton.None
    this.positionX = Infinity
    this.positionY = Infinity
    this.selectedX = Infinity
    this.selectedY = Infinity
    this.modifiers = KeyboardModifiers.None
    this.selected = false
  }

  protected updateSensorData(e: PointerEvent): void {
    this.preventDefault = false
    this.stopPropagation = false
    const path = e.composedPath()
    this.elementDataList = grabElementData(path, SymDataForSensor, 'button', this.elementDataList).data
    const elements = document.elementsFromPoint(e.clientX, e.clientY)
    this.elementDataUnderPointer = grabElementData(elements, SymDataForSensor, 'button', this.elementDataUnderPointer).data
    this.modifiers = extractModifierKeys(e)
    this.positionX = e.clientX
    this.positionY = e.clientY
    this.revision++
  }

  // @reaction
  // protected debug(): void {
  //   console.log(`Popup: elementDataList.length = ${this.elementDataList.length}`)
  //   console.log(`stage = ${ButtonState[this.state]}, originData = ${this.originData}, selected = ${this.selected}, selectedData = ${this.selectedData}, selectedXY = (${this.selectedX}, ${this.selectedY})`)
  // }
}
