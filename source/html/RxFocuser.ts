// The below copyright notice and the license permission notice
// shall be included in all copies or substantial portions.
// Copyright (C) 2019-2022 Yury Chetyrko <ychetyrko@gmail.com>
// License: https://raw.githubusercontent.com/nezaboodka/reactron/master/LICENSE
// By contributing, you agree that your contributions will be
// automatically licensed under the license referred above.

import { Reaction } from '../core/Elements'
import { FocusModel } from './sensors/FocusSensor'

export function RxFocuser(name: string, target: HTMLElement, model: FocusModel,
  switchEditMode: ((model?: FocusModel) => void) | undefined = undefined): void {
  Reaction(name, { target, model }, (_, node) => {
    if (switchEditMode !== undefined) {
      switchEditMode(model)
    }
    else {
      model.isEditMode ? target.focus() : target.blur()
      // console.log(`${model.isEditMode ? '🟢' : '🔴'} RxFocuser [${name}]: ${model.isEditMode ? 'focus()' : 'blur()'}`)
    }
  }, undefined, undefined, 0)
}
