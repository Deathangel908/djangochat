<template>
  <create-room
    :is-public="false"
    :user-ids="userIds"
  />
</template>
<script lang="ts">
  import {
    Component,
    Vue
  } from 'vue-property-decorator';
  import CreateRoom from '@/vue/pages/parts/CreateRoom.vue';
  import {State} from '@/ts/instances/storeInstance';
  import {PrivateRoomsIds} from '@/ts/types/types';

  @Component({components: {CreateRoom}})
export default class CreatePrivateRoom extends Vue {

  @State
  public readonly privateRoomsUsersIds!: PrivateRoomsIds;

  @State
  public readonly myId!: number;

  get userIds(): number[] {
    let users = Object.values(this.privateRoomsUsersIds.roomUsers);
    users.push(this.myId);
    return this.$store.usersArray
        .map(a=> a.id)
        .filter(uId => !users.includes(uId));
  }
}
</script>
