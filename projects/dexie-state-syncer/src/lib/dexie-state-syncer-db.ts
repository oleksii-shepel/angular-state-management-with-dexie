import Dexie from 'dexie';
import { primitive } from "./dexie-state-syncer-reducer";

export interface StateNode {
  id?: number;
  key: string;
  left: number | undefined;
  right: number | undefined;
  parent: number | undefined;
  data: any;
}

export class StateObjectDatabase extends Dexie {
  private _stateNodes!: Dexie.Table<StateNode, number>;
  public get stateNodes(): Dexie.Table<StateNode, number> {
    return this._stateNodes;
  }
  public set stateNodes(value: Dexie.Table<StateNode, number>) {
    this._stateNodes = value;
  }

  constructor() {
    super('StateObjectDatabase');
    this.version(1).stores({
      stateNodes: 'id, [id+key], parent',
    });
    this.stateNodes = this.table('stateNodes');
    this.on('populate', () => this.populate());
  }

  async clear() {
    await this.stateNodes.clear();
  }

  async populate() {

  }

  async get(key: number): Promise<StateNode | undefined>  {
    return this.stateNodes.get(key);
  }

  async set(node: StateNode): Promise<number> {
    return this.stateNodes.add(node);
  }

  async update(node: StateNode): Promise<number> {
    return this.stateNodes.put(node);
  }

  async remove(key: number): Promise<void> {
    return this.stateNodes.delete(key);
  }

  async toArray(): Promise<StateNode[]> {
    return this.stateNodes.toArray();
  }
}

export interface StateReader {
  find: (path: string | string[]) => Promise<StateNode | undefined>;
  get: (path: string | string[]) => Promise<any>;
}

export interface StateWriter {
  initialize: (obj: any) => Promise<StateNode | undefined>;
  update: (path: string, obj: any) => Promise<StateNode | undefined>;
}

export interface StateDescriptor {
  autoincrement: number;
  root: number | undefined;
  date: number;
  reader: StateReader;
  writer: StateWriter;
}

export class ObjectState {
  db: StateObjectDatabase;
  root: number | undefined;
  autoincrement: number;

  constructor() {
    this.db = new StateObjectDatabase();
    this.root = undefined;
    this.autoincrement = 0;
  }

  descriptor(): StateDescriptor {
    return { autoincrement: this.autoincrement, root: this.root, date: Date.now(),
      reader: {
        get: (path) => this.get(Array.isArray(path) ? path.join('.') : path),
        find: (path) => this.find(Array.isArray(path) ? path.join('.') : path)
      },
      writer: {
        initialize: (obj) => this.initialize(obj),
        update: (path, value) => this.update(Array.isArray(path) ? path.join('.') : path, value),
      }
    };
  }

  rootId(): number | undefined {
    return this.root;
  }

  async leaf(id: number): Promise<boolean> {
    try {
      return await this.db.transaction('r', this.db.stateNodes, async () => {
        let nodeValue = await this.db.get(id);
        return nodeValue?.left === undefined;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async createNode(key: string, data: any, parent: number | undefined): Promise<StateNode | undefined> {

    try {
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        if (parent === undefined) {
          if (this.root !== undefined) return undefined;
          const newNodeId = await this.db.set({
            id: this.autoincrement,
            key: 'root',
            left: undefined,
            right: undefined,
            parent: undefined,
            data: undefined,
          });

          const newNode = await this.db.get(newNodeId);

          this.root = this.autoincrement;
          this.autoincrement++;
          return newNode;
        }

        let parentNode = await this.db.get(parent);
        if (parentNode === undefined) return undefined;

        const newNodeId_1 = await this.db.set({
          id: this.autoincrement,
          key: key,
          left: undefined,
          right: undefined,
          parent: parent,
          data: primitive(data) ? data : undefined,
        });

        const newNode_1 = await this.db.get(this.autoincrement);

        this.autoincrement++;
        if (parentNode.left === undefined) {
          parentNode.left = newNode_1?.id!;
        } else {
          let siblingNode = await this.db.get(parentNode.left);
          while (siblingNode !== undefined && siblingNode.right !== undefined) {
            siblingNode = await this.db.get(siblingNode.right);
          }
          if (siblingNode !== undefined) {
            siblingNode.right = newNode_1?.id!;
          }
        }
        return newNode_1;
      });
    } catch (err) {
      return Promise.reject();
    }
  }

  async getNode(id: number): Promise<StateNode | undefined> {
    try {
      return await this.db.transaction('r', this.db.stateNodes, async () => {
        return await this.db.get(id);
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getChildNodes(id: number): Promise<StateNode[] | undefined> {
    try {
      return await this.db.transaction('r', this.db.stateNodes, async () => {
        const node = await this.db.get(id);

        if (node && node.left) {
          let children = [], left = await this.db.get(node.left)!;
          while (left?.right !== undefined) {
            children.push(left);
            left = await this.db.get(left.right)!;
          }

          return children;
        }

        return undefined;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async deleteNode(id: number) {
    try {
      await this.db.transaction('rw', this.db.stateNodes, async () => {
        const node = await this.db.get(id);
        if (!node) return;

        // Recursively delete all left descendants
        let leftChildId = node.left;
        while (leftChildId) {
          const leftChild = await this.db.get(leftChildId);
          if (leftChild) {
            await this.deleteNode(leftChild.id!);
            leftChildId = leftChild.right;
          } else {
            leftChildId = undefined;
          }
        }

        // Remove the node if it has no parent (it's the root)
        if (node.parent === undefined) {
          await this.db.remove(id);
          this.root = undefined;
        } else {
          // Update the parent's left reference if necessary
          const parentNode = await this.db.get(node.parent);
          if (parentNode && parentNode.left === id) {
            await this.db.remove(id);
            parentNode.left = node.right;
            await this.db.set(parentNode);
          } else {
            // Find and update the sibling that points to this node
            let siblingId = parentNode?.left;
            while (siblingId) {
              const siblingNode = await this.db.get(siblingId);
              if (siblingNode && siblingNode.right === id) {
                siblingNode.right = node.right;
                await this.db.set(siblingNode);
                break;
              }
              siblingId = siblingNode?.right;
            }
            await this.db.remove(id);
          }
        }
      });
    } catch (err) {
      console.error('Failed to delete node with id:', id, err);
      throw err; // Rethrow the error to be handled by the caller
    }
  }


  async updateNode(id: number, updates: { left?: number; right?: number; parent?: number; }): Promise<StateNode | undefined> {
    try {
      // Access the node by its ID and update the necessary properties
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        let node = await this.db.get(id);
        if (node) {
          // Update the node's properties with the provided updates
          node = { ...node, ...updates };
          await this.db.update(node);
          return await this.db.get(id);
        } else {
          throw new Error(`Node with ID ${id} not found`);
        }
      });
    } catch (err) {
      throw err;
    }
  }

  async touchNode(id: number, updates: { left?: number; right?: number; parent?: number; }): Promise<StateNode | undefined> {
    try {
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        let node = await this.db.get(id);
        if (!node) {
          throw new Error('Node not found');
        }

        // Create a clone of the node with a new ID
        let newNode: StateNode = {
          ...node,
          ...updates,
          id: this.autoincrement // Assign a new ID from autoincrement
        };

        // Save the new node to the database with the new ID
        await this.db.set(newNode);

        // Update the 'left' reference of the parent node, if applicable
        if (node.parent) {
          let parentNode = await this.db.get(node.parent);
          if (parentNode && parentNode.left === id) {
            parentNode.left = this.autoincrement;
            await this.db.set(parentNode);
          }
        }

        // Update the 'right' reference of the previous sibling node, if applicable
        if (node.parent) {
          let siblingNodes = await this.db.stateNodes.where({ parent: node.parent }).toArray();
          for (const sibling of siblingNodes) {
            if (sibling.right === id) {
              sibling.right = this.autoincrement;
              await this.db.set(sibling);
              break;
            }
          }
        }

        // Remove the old node from the database
        await this.db.remove(id);

        // Increment the autoincrement value for the next node
        this.autoincrement++;

        return newNode; // Return the new node
      });
    } catch (err) {
      console.error(err);
      return Promise.reject(err);
    }
  }

  async getData(node: StateNode): Promise<any> {
    try {
      return await this.db.transaction('r', this.db.stateNodes, async () => {
        if (node === undefined) {
          throw new Error("Tree node cannot be undefined");
        }

        let data = node.left ? {} : node.data;

        if (node.left !== undefined) {
          let left = await this.db.get(node.left) as StateNode | undefined;
          while (left !== undefined) {
            data[left.key] = await this.getData(left);
            left = left.right ? await this.db.get(left.right) : undefined;
          }
        }

        return data;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }


  async initialize(obj: any): Promise<StateNode | undefined> {
    try {
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        this.root = undefined;
        this.autoincrement = 0;
        await this.db.clear();

        const rootNode = await this.createNode('root', undefined, undefined);
        const root = rootNode?.id;

        let queue = [{ obj: obj, parent: root, previousSibling: undefined }];

        while (queue.length > 0) {
          let { obj, parent, previousSibling } = queue.shift() as { obj: any; parent: number | undefined; previousSibling: number | undefined };
          let firstChild = undefined;

          for (const key in obj) {
            const value = obj[key];
            const record = await this.createNode(key, value, parent);
            if (!record) {
              throw new Error('Failed to create a node');
            }

            if (!firstChild) {
              firstChild = record.id;
              // Retrieve the parent node from the database, update it, and save it back
              let parentNode = await this.db.get(parent!);
              if (parentNode) {
                parentNode.left = firstChild;
                await this.db.set(parentNode);
              }
            } else {
              // Retrieve the previous sibling from the database, update it, and save it back
              let prevSiblingNode = await this.db.get(previousSibling!);
              if (prevSiblingNode) {
                prevSiblingNode.right = record.id;
                await this.db.set(prevSiblingNode);
              }
            }

            previousSibling = record.id;

            if (typeof value === 'object') {
              queue.push({ obj: value, parent: record.id, previousSibling: undefined });
            }
          }
        }
        return rootNode;
      });
    } catch (err) {
      console.error('Error initializing tree:', err);
      throw err;
    }
  }

  async find(path: string): Promise<StateNode | undefined> {
    try {
      return await this.db.transaction('r', this.db.stateNodes, async () => {
        let node = await this.db.get(this.root!);

        if(typeof path === 'string' && path.length > 0) {
          const split = path.split('.');

          for (const part of split) {
            let nextChild = node && node.left !== undefined ? await this.db.get(node.left) : undefined;
            while (nextChild !== undefined && nextChild.key !== part) {
              nextChild = nextChild.right !== undefined ? await this.db.get(nextChild.right) : undefined;
            }
            return nextChild;
          }
        }

        return node;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async get(path: string): Promise<any> {
    try {
      return await this.db.transaction('r', this.db.stateNodes, async () => {
        let subtree = await this.find(path);
        return subtree !== undefined ? await this.getData(subtree) : undefined;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async create(obj: any, path: string): Promise<any> {
    try {
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        let node = undefined;
        if (this.root === undefined) {
          // Create a new root node if none exists
          node = await this.createNode('root', undefined, undefined);
          this.root = node!.id; // Set the new node as the root
        } else {
          // Fetch the existing root node
          node = await this.db.get(this.root);
        }

        if (typeof path === 'string' && path.length > 0) {
          const split = path.split('.');

          let parent = node;
          for (const part of split) {
            let child = parent && parent.left ? await this.db.get(parent.left) : undefined;
            let nextChild = child;

            while (nextChild && nextChild.key !== part) {
              nextChild = nextChild.right ? await this.db.get(nextChild.right) : undefined;
            }

            if (!nextChild) {
              nextChild = parent ? await this.createNode(part, undefined, parent.id) : undefined;
              parent = nextChild; // Update the parent reference
            } else {
              await this.touchNode(nextChild.id!, {});
            }
          }

          let queue = [{ obj: obj, parent: parent ? parent.id : undefined }];
          while (queue.length > 0) {
            const { obj: currentObj, parent: parentId } = queue.shift()!;
            if (typeof currentObj === 'object' && currentObj !== null) {
              for (const key in currentObj) {
                if (currentObj.hasOwnProperty(key)) {
                  const value = currentObj[key];
                  const record = parentId !== undefined ? await this.createNode(key, value, parentId) : undefined;

                  if (typeof value === 'object' && value !== null && record) {
                    queue.push({ obj: value, parent: record.id });
                  }
                }
              }
            }
          }
        }
        return node;
      });
    } catch (err) {
      console.error('Failed to create node:', err);
      throw err;
    }
  }


  async update(path: string, obj: any) {
    try {
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        await this.delete(path);
        return await this.create(obj, path);
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async delete(path: string): Promise<void> {
    try {
      await this.db.transaction('rw', this.db.stateNodes, async () => {
        const nodeToDelete = await this.find(path);
        if (!nodeToDelete) return;

        // If the node to delete is the root, set the root to undefined
        if (this.root === nodeToDelete.id) {
          this.root = undefined;
        } else {
          // Proceed with deleting the subtree
          await this.recursivelyDeleteSubtree(nodeToDelete.left);

          // Update the parent's child references only if the node is not the root
          // Explicitly check for null or undefined
          const parent = (nodeToDelete.parent !== undefined) ? await this.db.get(nodeToDelete.parent) : undefined;
          if (parent) {
            if (parent.left === nodeToDelete.id) {
              parent.left = nodeToDelete.right;
              await this.db.set(parent); // Update the parent node in the database
            } else {
              let current = parent.left !== undefined ? await this.db.get(parent.left) : undefined;
              while (current?.right && current.right !== nodeToDelete.id) {
                current = await this.db.get(current.right);
              }
              if (current) {
                current.right = nodeToDelete.right;
                await this.db.set(current); // Update the current node in the database
              }
            }
          }
        }

        // Delete the node
        await this.deleteNode(nodeToDelete.id!);
      });
    } catch (err) {
      console.error('Failed to delete node:', err);
      throw err;
    }
  }



  async recursivelyDeleteSubtree(id: number | undefined) {
    try {
      if (id === undefined) {
        return;
      }
      const node = await this.db.get(id);
      if (node) {
        // Recursively delete the left subtree (the left child and all its right siblings)
        let childId = node.left;
        while (childId !== undefined) {
          const childNode = await this.db.get(childId);
          if (childNode) {
            // Recursively delete the left child of the current child node
            if (childNode.left !== undefined) {
              await this.recursivelyDeleteSubtree(childNode.left);
            }
            // Save the right sibling ID before deleting the current child node
            const rightSiblingId = childNode.right;
            // Delete the current child node
            await this.deleteNode(childId);
            // Move on to the right sibling
            childId = rightSiblingId;
          }
        }
      }
    } catch (err) {
      return Promise.reject(err);
    }
  }
}
