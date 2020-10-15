import {getModule, VuexModule} from 'vuex-module-decorators';
import {DefaultStore} from '@/utils/store';
import {IS_DEBUG} from '@/utils/consts';
import Vue from 'vue';

function StateDecoratorFactory<ProviderType extends VuexModule>(vuexModule: ProviderType) {
  function State<ConsumerType extends (ConsumerType[PropName] extends ProviderType[PropName] ? unknown : never),
      PropName extends (keyof ConsumerType & keyof ProviderType),
      >(vueComponent: ConsumerType,
        fileName: PropName) {
    {
      Object.defineProperty(vueComponent, fileName, <PropertyDescriptor>Object.getOwnPropertyDescriptor(vuexModule, fileName));
    }
  }

  // TODO if types of arguments are absent on VueComponent ts wouldn't warn
  function Mutation<ConsumerType extends (ConsumerType[PropName] extends ProviderType[PropName] ? unknown : never),
      PropName extends (keyof ConsumerType & keyof ProviderType),
      >(vueComponent: ConsumerType,
        fileName: PropName,
        descriptor: PropertyDescriptor) {
    {
      descriptor.value = Object.getOwnPropertyDescriptor(vuexModule, fileName)!.value;
    }
  }

  return {State, Mutation};
}

export const store: DefaultStore = getModule(DefaultStore);
export const {State} = StateDecoratorFactory(store);

Vue.prototype.store = store;

if (IS_DEBUG) {
  window.store = store;
}
